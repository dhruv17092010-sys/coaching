// ============================================================
// ChalkQuiz — app.js
// All quiz logic lives here. No frameworks, no build step.
// ============================================================

const LOADING_LINES = [
  "Sharpening the chalk…",
  "Consulting the AI teacher's assistant…",
  "Writing questions on the board…",
  "Double-checking the answer key…",
];

// ---------------------------------------------------------------
// Shared: fetch with exponential backoff
// ---------------------------------------------------------------
// Retries on transient server errors (503 "server overloaded" is the
// most common one from busy AI APIs, plus 429/502/504) using
// exponential backoff with jitter. Used by every network call in the
// app (app.js and board.js) so a busy moment on Google's side doesn't
// immediately fail the student's request.
const RETRYABLE_STATUS_CODES = [429, 502, 503, 504];

/**
 * @param {string} url
 * @param {RequestInit} options
 * @param {{maxRetries?:number, baseDelayMs?:number, maxDelayMs?:number, onRetry?:(info:{attempt:number,maxRetries:number,delayMs:number,reason:string})=>void}} [config]
 */
async function fetchWithRetry(url, options, config = {}) {
  const { maxRetries = 5, baseDelayMs = 1000, maxDelayMs = 20000, onRetry } = config;
  let attempt = 0;

  while (true) {
    let res;
    let networkError = null;
    try {
      res = await fetch(url, options);
    } catch (err) {
      networkError = err;
    }

    const shouldRetry =
      attempt < maxRetries && (networkError !== null || (res && RETRYABLE_STATUS_CODES.includes(res.status)));

    if (!shouldRetry) {
      if (networkError) throw networkError;
      return res;
    }

    const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    const jitteredDelayMs = Math.round(delayMs * (0.5 + Math.random() * 0.5));
    const reason = networkError ? "Network error" : `Server responded ${res.status}`;

    attempt += 1;
    if (onRetry) onRetry({ attempt, maxRetries, delayMs: jitteredDelayMs, reason });

    await new Promise((resolve) => setTimeout(resolve, jitteredDelayMs));
  }
}

/** @typedef {{question:string, options:string[], correctIndex:number, explanation:string}} QuizQuestion */

const state = {
  screen: "setup",
  questions: /** @type {QuizQuestion[]} */ ([]),
  currentIndex: 0,
  answers: /** @type {(number|null)[]} */ ([]),
  meta: { topic: "", grade: "", difficulty: "", numQuestions: 10, timerEnabled: true, timerMinutes: 10 },
  timer: { totalSeconds: 0, remainingSeconds: 0, intervalId: null, startedAt: null },
  reviewOpen: false,
  historyTab: "quiz",
};

// ---------------------------------------------------------------
// Element refs
// ---------------------------------------------------------------
const el = (id) => document.getElementById(id);

const screens = {
  setup: el("screen-setup"),
  loading: el("screen-loading"),
  quiz: el("screen-quiz"),
  results: el("screen-results"),
  history: el("screen-history"),
  boardSetup: el("screen-board-setup"),
  boardLoading: el("screen-board-loading"),
  boardPaper: el("screen-board-paper"),
  boardUpload: el("screen-board-upload"),
  boardChecking: el("screen-board-checking"),
  boardResults: el("screen-board-results"),
  boardCancelled: el("screen-board-cancelled"),
};

const QUIZ_SECTION_SCREENS = new Set(["setup", "loading", "quiz", "results"]);
const BOARD_SECTION_SCREENS = new Set([
  "boardSetup",
  "boardLoading",
  "boardPaper",
  "boardUpload",
  "boardChecking",
  "boardResults",
  "boardCancelled",
]);

function showScreen(name) {
  Object.values(screens).forEach((s) => (s.hidden = true));
  screens[name].hidden = false;
  state.screen = name;
  window.scrollTo({ top: 0, behavior: "smooth" });

  el("nav-home").dataset.active = String(QUIZ_SECTION_SCREENS.has(name));
  el("nav-board").dataset.active = String(BOARD_SECTION_SCREENS.has(name));
  el("nav-history").dataset.active = String(name === "history");
}

// ---------------------------------------------------------------
// Setup form
// ---------------------------------------------------------------
const form = el("quiz-form");
const chipGroup = el("question-count-group");
const numQuestionsInput = el("numQuestions");
const timerEnabledInput = el("timer-enabled");
const timerMinutesRow = el("timer-input-row");
const timerMinutesInput = el("timer-minutes");
const formError = el("form-error");

chipGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  chipGroup.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-selected"));
  btn.classList.add("is-selected");
  numQuestionsInput.value = btn.dataset.value;
});

timerEnabledInput.addEventListener("change", () => {
  timerMinutesRow.style.opacity = timerEnabledInput.checked ? "1" : "0.4";
  timerMinutesInput.disabled = !timerEnabledInput.checked;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;

  const topic = el("topic").value.trim();
  const grade = el("grade").value;
  const difficulty = el("difficulty").value;
  const numQuestions = parseInt(numQuestionsInput.value, 10);
  const timerEnabled = timerEnabledInput.checked;
  const timerMinutes = Math.max(1, parseInt(timerMinutesInput.value, 10) || 10);

  if (!topic || !grade) {
    formError.textContent = "Please fill in a topic and grade level.";
    formError.hidden = false;
    return;
  }

  state.meta = { topic, grade, difficulty, numQuestions, timerEnabled, timerMinutes };

  await generateQuiz();
});

// ---------------------------------------------------------------
// Calling the Supabase Edge Function (which calls Gemini securely)
// ---------------------------------------------------------------
async function generateQuiz() {
  showScreen("loading");
  el("loading-text").textContent = LOADING_LINES[0];
  let lineIdx = 0;
  const lineInterval = setInterval(() => {
    lineIdx = (lineIdx + 1) % LOADING_LINES.length;
    el("loading-text").textContent = LOADING_LINES[lineIdx];
  }, 1800);

  try {
    const res = await fetchWithRetry(
      GENERATE_QUIZ_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          topic: state.meta.topic,
          grade: state.meta.grade,
          difficulty: state.meta.difficulty,
          numQuestions: state.meta.numQuestions,
        }),
      },
      {
        onRetry: ({ attempt, maxRetries, delayMs, reason }) => {
          el("loading-text").textContent = `Server's busy (${reason}) — retrying in ${Math.round(
            delayMs / 1000
          )}s… (${attempt}/${maxRetries})`;
        },
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Server responded with ${res.status}. ${text}`);
    }

    const data = await res.json();
    const questions = normalizeQuestions(data.questions);

    if (!questions.length) throw new Error("The AI didn't return any usable questions.");

    state.questions = questions;
    state.answers = new Array(questions.length).fill(null);
    state.currentIndex = 0;

    startQuiz();
  } catch (err) {
    console.error(err);
    clearInterval(lineInterval);
    showScreen("setup");
    formError.textContent =
      "Couldn't generate a quiz right now (" + (err.message || "unknown error") + "). Please check your connection and try again.";
    formError.hidden = false;
    return;
  }
  clearInterval(lineInterval);
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length >= 2)
    .map((q) => ({
      question: q.question.trim(),
      options: q.options.map((o) => String(o).trim()),
      correctIndex: Math.max(0, Math.min(q.options.length - 1, parseInt(q.correctIndex, 10) || 0)),
      explanation: typeof q.explanation === "string" ? q.explanation.trim() : "",
    }));
}

// ---------------------------------------------------------------
// Quiz screen
// ---------------------------------------------------------------
const optionLetters = ["A", "B", "C", "D", "E", "F"];

function startQuiz() {
  el("quiz-topic-label").textContent = `${state.meta.topic} · ${state.meta.grade}`;
  showScreen("quiz");
  renderQuestion();

  if (state.meta.timerEnabled) {
    startTimer(state.meta.timerMinutes * 60);
    el("timer-chip").hidden = false;
  } else {
    el("timer-chip").hidden = true;
    state.timer.startedAt = Date.now();
  }
}

function renderQuestion() {
  const q = state.questions[state.currentIndex];
  const total = state.questions.length;

  el("question-index").textContent = `Q${state.currentIndex + 1}`;
  el("quiz-progress-label").textContent = `Question ${state.currentIndex + 1} of ${total}`;
  el("question-text").textContent = q.question;
  el("progress-fill").style.width = `${((state.currentIndex + 1) / total) * 100}%`;

  const list = el("options-list");
  list.innerHTML = "";
  q.options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    if (state.answers[state.currentIndex] === i) btn.classList.add("is-selected");
    btn.innerHTML = `<span class="option-letter">${optionLetters[i]}</span><span>${escapeHtml(opt)}</span>`;
    btn.addEventListener("click", () => {
      state.answers[state.currentIndex] = i;
      renderQuestion();
    });
    list.appendChild(btn);
  });

  el("prev-btn").disabled = state.currentIndex === 0;
  el("prev-btn").style.visibility = state.currentIndex === 0 ? "hidden" : "visible";
  el("next-btn").querySelector(".btn-label")?.remove();
  el("next-btn").textContent = state.currentIndex === total - 1 ? "Submit quiz" : "Next";
}

el("prev-btn").addEventListener("click", () => {
  if (state.currentIndex > 0) {
    state.currentIndex -= 1;
    renderQuestion();
  }
});

el("next-btn").addEventListener("click", () => {
  const isLast = state.currentIndex === state.questions.length - 1;
  if (isLast) {
    finishQuiz();
  } else {
    state.currentIndex += 1;
    renderQuestion();
  }
});

// ---------------------------------------------------------------
// Timer
// ---------------------------------------------------------------
function startTimer(totalSeconds) {
  clearInterval(state.timer.intervalId);
  state.timer.totalSeconds = totalSeconds;
  state.timer.remainingSeconds = totalSeconds;
  state.timer.startedAt = Date.now();
  updateTimerDisplay();

  state.timer.intervalId = setInterval(() => {
    state.timer.remainingSeconds -= 1;
    updateTimerDisplay();
    if (state.timer.remainingSeconds <= 0) {
      clearInterval(state.timer.intervalId);
      finishQuiz();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const s = Math.max(0, state.timer.remainingSeconds);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  el("timer-display").textContent = `${mm}:${ss}`;
  el("timer-chip").classList.toggle("is-low", s <= 30);
}

function stopTimer() {
  clearInterval(state.timer.intervalId);
}

// ---------------------------------------------------------------
// Results + scoring
// ---------------------------------------------------------------
function finishQuiz() {
  stopTimer();

  const total = state.questions.length;
  let correct = 0;
  state.questions.forEach((q, i) => {
    if (state.answers[i] === q.correctIndex) correct += 1;
  });

  const elapsedSeconds = state.meta.timerEnabled
    ? state.timer.totalSeconds - Math.max(0, state.timer.remainingSeconds)
    : Math.round((Date.now() - state.timer.startedAt) / 1000);

  const percent = Math.round((correct / total) * 100);

  const result = {
    id: `quiz_${Date.now()}`,
    date: new Date().toISOString(),
    topic: state.meta.topic,
    grade: state.meta.grade,
    difficulty: state.meta.difficulty,
    numQuestions: total,
    correct,
    percent,
    timeTakenSeconds: elapsedSeconds,
    questions: state.questions,
    answers: state.answers,
  };

  saveResultToHistory(result);
  renderResults(result);
  showScreen("results");
}

function renderResults(result) {
  el("results-title").textContent =
    result.percent >= 80 ? "Nice work!" : result.percent >= 50 ? "Good effort!" : "Keep practicing!";
  el("score-fraction").textContent = `${result.correct}/${result.numQuestions}`;
  el("score-percent").textContent = `${result.percent}%`;
  el("results-sub").textContent = `You answered ${result.correct} of ${result.numQuestions} correctly in ${formatTime(
    result.timeTakenSeconds
  )}.`;

  const circumference = 2 * Math.PI * 60;
  const offset = circumference - (result.percent / 100) * circumference;
  const ring = el("ring-fill");
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference}`;
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = `${offset}`;
  });
  ring.style.stroke =
    result.percent >= 80 ? "var(--mint-500)" : result.percent >= 50 ? "var(--gold-500)" : "var(--coral-500)";

  state.reviewOpen = false;
  el("review-list").hidden = true;
  el("review-toggle-btn").textContent = "Review answers";
  renderReview(result);
}

function renderReview(result) {
  const container = el("review-list");
  container.innerHTML = "";
  result.questions.forEach((q, i) => {
    const userAnswer = result.answers[i];
    const item = document.createElement("div");
    item.className = "review-item";

    const optionsHtml = q.options
      .map((opt, oi) => {
        let cls = "option-btn";
        if (oi === q.correctIndex) cls += " is-correct";
        else if (oi === userAnswer) cls += " is-incorrect";
        return `<div class="${cls}"><span class="option-letter">${optionLetters[oi]}</span><span>${escapeHtml(
          opt
        )}</span></div>`;
      })
      .join("");

    const explanationHtml = q.explanation
      ? `<div class="explanation"><strong>Why:</strong> ${escapeHtml(q.explanation)}</div>`
      : "";

    item.innerHTML = `
      <p class="question-index">Q${i + 1}${userAnswer === null ? " · skipped" : ""}</p>
      <p class="question-text">${escapeHtml(q.question)}</p>
      <div class="options-list">${optionsHtml}</div>
      ${explanationHtml}
    `;
    container.appendChild(item);
  });
}

el("review-toggle-btn").addEventListener("click", () => {
  state.reviewOpen = !state.reviewOpen;
  el("review-list").hidden = !state.reviewOpen;
  el("review-toggle-btn").textContent = state.reviewOpen ? "Hide review" : "Review answers";
});

el("retake-btn").addEventListener("click", () => {
  form.reset();
  chipGroup.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-selected"));
  chipGroup.querySelector('[data-value="10"]').classList.add("is-selected");
  numQuestionsInput.value = "10";
  el("difficulty").value = "Medium";
  timerEnabledInput.checked = true;
  timerMinutesInput.value = 10;
  showScreen("setup");
});

// ---------------------------------------------------------------
// localStorage history
// ---------------------------------------------------------------
const STORAGE_KEYS = {
  quiz: "chalkquiz_history",
  board: "chalkquiz_board_history",
};

function getHistory(type = "quiz") {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[type]);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveResultToHistory(result, type = "quiz") {
  const history = getHistory(type);
  history.unshift(result);
  // Keep the most recent 50 attempts so localStorage doesn't grow unbounded
  const trimmed = history.slice(0, 50);
  try {
    localStorage.setItem(STORAGE_KEYS[type], JSON.stringify(trimmed));
  } catch (err) {
    console.warn("Could not save result to localStorage:", err);
  }
}

function renderHistory(type = "quiz") {
  const history = getHistory(type);
  const list = el("history-list");
  const clearBtn = el("clear-history-btn");

  if (!history.length) {
    list.innerHTML = `<p class="empty-state">${
      type === "quiz" ? "No quizzes yet — take one and it'll show up here." : "No board exam attempts yet — try one from the Board Exam tab."
    }</p>`;
    clearBtn.hidden = true;
    return;
  }

  clearBtn.hidden = false;
  clearBtn.dataset.type = type;
  list.innerHTML = "";
  history.forEach((r) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const date = new Date(r.date);
    const subtitle =
      type === "quiz"
        ? `${escapeHtml(r.grade)} · ${escapeHtml(r.difficulty)} · ${r.numQuestions} questions`
        : `${escapeHtml(r.className)} · ${escapeHtml(r.board)} · ${r.totalMarks} marks`;
    item.innerHTML = `
      <div class="history-item-main">
        <p class="history-topic">${escapeHtml(r.topic)}</p>
        <p class="history-meta">${subtitle} · ${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}</p>
      </div>
      <div class="history-score">${r.percent}%</div>
    `;
    item.style.cursor = "pointer";
    item.addEventListener("click", () => {
      if (type === "quiz") {
        renderResults(r);
        showScreen("results");
      } else {
        renderBoardResults(r);
        showScreen("boardResults");
      }
    });
    list.appendChild(item);
  });
}

el("clear-history-btn").addEventListener("click", () => {
  const type = el("clear-history-btn").dataset.type || "quiz";
  const label = type === "quiz" ? "practice quiz" : "board exam";
  if (confirm(`Clear all saved ${label} history on this device? This can't be undone.`)) {
    localStorage.removeItem(STORAGE_KEYS[type]);
    renderHistory(type);
  }
});

// ---------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------
el("nav-home").addEventListener("click", () => showScreen("setup"));
el("nav-board").addEventListener("click", () => showScreen("boardSetup"));
el("nav-history").addEventListener("click", () => {
  renderHistory(state.historyTab || "quiz");
  showScreen("history");
});

el("history-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".history-tab");
  if (!btn) return;
  document.querySelectorAll(".history-tab").forEach((t) => t.classList.remove("is-active"));
  btn.classList.add("is-active");
  state.historyTab = btn.dataset.tab;
  renderHistory(state.historyTab);
});

// ---------------------------------------------------------------
// Utils
// ---------------------------------------------------------------
function formatTime(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// init
timerMinutesRow.style.opacity = "1";
showScreen("setup");
