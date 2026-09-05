// ============================================================
// ChalkQuiz — board.js
// Board Exam Simulator: sectioned question paper -> full-screen
// timed writing with server-enforced anti-cheat -> ordered photo
// upload -> AI grading.
// Relies on shared helpers (el, escapeHtml, showScreen, formatTime,
// fetchWithRetry, getHistory, saveResultToHistory, renderHistory)
// defined in app.js, which loads before this file.
// ============================================================

const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_PHOTOS = 8;
const MAX_IMAGE_DIMENSION = 1600;
const VIOLATION_COOLDOWN_MS = 4000;

const BOARD_LOADING_LINES = [
  "Setting the exam…",
  "Drafting questions to your syllabus…",
  "Balancing the marking scheme…",
  "Almost ready…",
];

const BOARD_CHECKING_LINES = [
  "Reading your handwriting…",
  "Matching answers to the marking scheme…",
  "Awarding step marks…",
  "Writing improvement notes…",
];

const VIOLATION_LABELS = {
  exited_fullscreen: "you exited full-screen mode",
  tab_hidden_or_switched: "you switched away from this tab or app",
  window_lost_focus: "this browser window lost focus",
  attempted_tab_or_window_shortcut: "you used a new-tab/close-tab keyboard shortcut",
  attempted_close_or_reload: "you tried to close or reload the tab",
};

const SECTION_META = {
  A: { title: "Section A — Multiple Choice Questions", hint: "Write just the option letter (A/B/C/D) for each." },
  B: { title: "Section B — Case Study / Source-Based Questions", hint: "Read the passage, then answer the numbered sub-questions." },
  C: { title: "Section C — Short & Long Answer Questions", hint: "" },
};

const boardState = {
  meta: { subject: "", chapter: "", className: "", board: "CBSE", totalMarks: 20, timerMinutes: 40 },
  paper: /** @type {{id:string, section:string, type:string, marks:number, questionText:string, passage:string, options:string[], markingScheme:any}[]} */ ([]),
  sessionId: /** @type {string|null} */ (null),
  warnings: 0,
  timer: { totalSeconds: 0, remainingSeconds: 0, intervalId: null, startedAt: null },
  photos: /** @type {{dataUrl:string, mimeType:string, base64:string}[]} */ ([]),
  attempt: 0,
};

// ---------------------------------------------------------------
// Setup form
// ---------------------------------------------------------------
const boardForm = el("board-form");
const boardMarksGroup = el("board-marks-group");
const boardTotalMarksInput = el("board-total-marks");
const boardTimerInput = el("board-timer-minutes");
const boardFormError = el("board-form-error");

boardMarksGroup.addEventListener("click", (e) => {
  const btn = e.target.closest(".chip");
  if (!btn) return;
  boardMarksGroup.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-selected"));
  btn.classList.add("is-selected");
  const marks = parseInt(btn.dataset.value, 10);
  boardTotalMarksInput.value = String(marks);
  boardTimerInput.value = String(Math.round(marks * 2));
});

boardForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  boardFormError.hidden = true;

  const subject = el("board-subject").value.trim();
  const chapter = el("board-chapter").value.trim();
  const className = el("board-class").value;
  const boardType = el("board-type").value;
  const totalMarks = parseInt(boardTotalMarksInput.value, 10);
  const timerMinutes = Math.max(5, parseInt(boardTimerInput.value, 10) || 40);

  if (!subject || !className) {
    boardFormError.textContent = "Please fill in a subject and class.";
    boardFormError.hidden = false;
    return;
  }

  boardState.meta = { subject, chapter, className, board: boardType, totalMarks, timerMinutes };
  boardState.attempt = 0;
  boardState.photos = [];
  boardState.sessionId = null;
  boardState.warnings = 0;

  await generatePaper();
});

// ---------------------------------------------------------------
// Generate paper (Edge Function #2 — GEMINI_API_KEY_PAPER)
// ---------------------------------------------------------------
async function generatePaper() {
  showScreen("boardLoading");
  cycleLoadingText("board-loading-text", BOARD_LOADING_LINES);

  try {
    const res = await fetchWithRetry(
      GENERATE_PAPER_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(boardState.meta),
      },
      {
        onRetry: ({ attempt, maxRetries, delayMs, reason }) => {
          el("board-loading-text").textContent = `Server's busy (${reason}) — retrying in ${Math.round(
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
    const questions = Array.isArray(data.questions) ? data.questions : [];

    if (!questions.length) throw new Error("The AI didn't return any usable questions.");

    boardState.paper = questions;
    boardState.sessionId = data.sessionId || null;

    if (!boardState.sessionId) {
      console.warn(
        "No exam session id returned — the anti-cheat warning system is inactive for this paper (see SETUP.md, Board Exam Simulator SQL step)."
      );
    }

    startBoardPaper();
  } catch (err) {
    console.error(err);
    stopLoadingCycle();
    showScreen("boardSetup");
    boardFormError.textContent =
      "Couldn't generate a question paper right now (" + (err.message || "unknown error") + "). Please try again.";
    boardFormError.hidden = false;
  }
}

// ---------------------------------------------------------------
// Writing screen: fullscreen gate + sectioned paper + timer
// ---------------------------------------------------------------
function startBoardPaper() {
  el("board-paper-label").textContent = `${boardState.meta.subject} · ${boardState.meta.className} · ${boardState.meta.board}`;
  el("board-paper-marks").textContent = `${boardState.meta.totalMarks} marks`;

  renderPaperQuestions();

  el("paper-start-overlay").hidden = false;
  el("paper-start-error").hidden = true;
  el("violation-warning-overlay").hidden = true;
  el("board-warnings-chip").hidden = true;

  showScreen("boardPaper");
  // Timer + monitoring start only once the student confirms full-screen (see paper-start-btn below).
}

function renderPaperQuestions() {
  const container = el("paper-questions");
  container.innerHTML = "";
  let currentSection = null;
  let displayIndex = 0;

  boardState.paper.forEach((q) => {
    if (q.section !== currentSection) {
      currentSection = q.section;
      const meta = SECTION_META[currentSection] || { title: `Section ${currentSection}`, hint: "" };
      const heading = document.createElement("div");
      heading.className = "paper-section-heading";
      heading.innerHTML = `<h3>${escapeHtml(meta.title)}</h3>${meta.hint ? `<p>${escapeHtml(meta.hint)}</p>` : ""}`;
      container.appendChild(heading);
    }

    displayIndex += 1;
    const item = document.createElement("div");
    item.className = "paper-question";

    let bodyHtml = "";
    if (q.passage) {
      bodyHtml += `<div class="paper-passage">${escapeHtml(q.passage)}</div>`;
    }
    bodyHtml += `<p class="question-text">${escapeHtml(q.questionText)}</p>`;
    if (q.type === "mcq" && Array.isArray(q.options) && q.options.length) {
      bodyHtml += `<div class="mcq-options">${q.options
        .map(
          (o, oi) =>
            `<div class="mcq-option"><span class="option-letter">${String.fromCharCode(65 + oi)}</span><span>${escapeHtml(o)}</span></div>`
        )
        .join("")}</div>`;
    }

    item.innerHTML = `
      <div class="paper-question-head">
        <span class="question-index">Q${displayIndex}</span>
        <span class="marks-badge">${q.marks} mark${q.marks === 1 ? "" : "s"}</span>
      </div>
      ${bodyHtml}
    `;
    container.appendChild(item);
  });
}

el("paper-start-btn").addEventListener("click", async () => {
  try {
    await requestFullscreenSafe();
  } catch {
    el("paper-start-error").textContent = "Couldn't enter full-screen mode. Please allow full-screen for this site and try again.";
    el("paper-start-error").hidden = false;
    return;
  }

  el("paper-start-overlay").hidden = true;
  boardState.warnings = 0;
  el("board-warnings-chip").hidden = boardState.sessionId ? false : true;
  updateWarningsChip();

  armViolationMonitor();
  startBoardTimer(boardState.meta.timerMinutes * 60);
});

el("violation-warning-continue-btn").addEventListener("click", () => {
  el("violation-warning-overlay").hidden = true;
  if (!isFullscreen()) requestFullscreenSafe().catch(() => {});
});

// ---------------------------------------------------------------
// Timer
// ---------------------------------------------------------------
function startBoardTimer(totalSeconds) {
  clearInterval(boardState.timer.intervalId);
  boardState.timer.totalSeconds = totalSeconds;
  boardState.timer.remainingSeconds = totalSeconds;
  boardState.timer.startedAt = Date.now();
  updateBoardTimerDisplay();

  boardState.timer.intervalId = setInterval(() => {
    boardState.timer.remainingSeconds -= 1;
    updateBoardTimerDisplay();
    if (boardState.timer.remainingSeconds <= 0) {
      clearInterval(boardState.timer.intervalId);
      goToUploadScreen();
    }
  }, 1000);
}

function updateBoardTimerDisplay() {
  const s = Math.max(0, boardState.timer.remainingSeconds);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  el("board-timer-display").textContent = `${mm}:${ss}`;
  el("board-timer-chip").classList.toggle("is-low", s <= 60);
}

function stopBoardTimer() {
  clearInterval(boardState.timer.intervalId);
}

el("board-finish-btn").addEventListener("click", () => {
  goToUploadScreen();
});

function goToUploadScreen() {
  // Leaving the writing screen this way is a legitimate transition, not a
  // violation — disarm monitoring before touching fullscreen so the resulting
  // fullscreenchange/visibilitychange events aren't mistaken for cheating.
  disarmViolationMonitor();
  stopBoardTimer();
  exitFullscreenSafe();
  el("unclear-banner").hidden = true;
  showScreen("boardUpload");
  renderPhotoGrid();
}

// ---------------------------------------------------------------
// Anti-cheat monitor (Supabase-backed — see supabase/sql/exam_sessions.sql)
// ------------------------------------------------------------
// The warning count lives in the exam_sessions table, updated only via
// the report-violation Edge Function (service_role key, RLS-protected).
// This means even a student who edits this file's JavaScript in devtools
// cannot make the *server* forget a recorded warning — the worst they can
// do is stop new violations from being reported at all, which is an
// inherent limit of any purely client-side detector. See SETUP.md for
// what a stronger setup (proctoring extension, LMS integration) would add.
// ---------------------------------------------------------------
let monitorArmed = false;
let lastViolationAt = 0;

function armViolationMonitor() {
  monitorArmed = true;
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("beforeunload", onBeforeUnload);
}

function disarmViolationMonitor() {
  monitorArmed = false;
  document.removeEventListener("fullscreenchange", onFullscreenChange);
  document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("beforeunload", onBeforeUnload);
}

function onFullscreenChange() {
  if (monitorArmed && !isFullscreen()) triggerViolation("exited_fullscreen");
}

function onVisibilityChange() {
  if (monitorArmed && document.hidden) triggerViolation("tab_hidden_or_switched");
}

function onWindowBlur() {
  if (monitorArmed) triggerViolation("window_lost_focus");
}

function onKeyDown(e) {
  if (!monitorArmed) return;
  const key = (e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && ["t", "n", "w"].includes(key)) {
    triggerViolation("attempted_tab_or_window_shortcut");
  }
}

function onBeforeUnload(e) {
  if (!monitorArmed) return;
  // Best-effort: fetch with keepalive survives page unload (like sendBeacon,
  // but lets us keep the required auth headers).
  try {
    fetch(REPORT_VIOLATION_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ sessionId: boardState.sessionId, violationType: "attempted_close_or_reload" }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
  e.preventDefault();
  e.returnValue = "";
}

function triggerViolation(type) {
  if (!monitorArmed || !boardState.sessionId) return;
  const now = Date.now();
  if (now - lastViolationAt < VIOLATION_COOLDOWN_MS) return;
  lastViolationAt = now;
  reportViolation(type);
}

async function reportViolation(type) {
  if (!boardState.sessionId) return;
  try {
    const res = await fetchWithRetry(
      REPORT_VIOLATION_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ sessionId: boardState.sessionId, violationType: type }),
      },
      { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 3000 }
    );
    if (!res.ok) {
      console.warn("Violation report failed:", res.status);
      return;
    }
    const data = await res.json();
    boardState.warnings = typeof data.warnings === "number" ? data.warnings : boardState.warnings;
    updateWarningsChip();

    if (data.status === "cancelled") {
      cancelExamDueToViolation(type);
    } else {
      showWarningBanner(boardState.warnings, type);
    }
  } catch (err) {
    console.warn("Violation report error:", err);
  }
}

function updateWarningsChip() {
  const chip = el("board-warnings-chip");
  chip.hidden = false;
  chip.textContent = `Warnings: ${boardState.warnings}/2`;
  chip.classList.toggle("is-low", boardState.warnings >= 1);
}

function showWarningBanner(warnings, type) {
  el("violation-warning-eyebrow").textContent = `warning ${warnings} of 2`;
  el("violation-warning-message").textContent = `We detected: ${
    VIOLATION_LABELS[type] || "an integrity issue"
  }. One more violation will cancel your paper.`;
  el("violation-warning-overlay").hidden = false;
}

function cancelExamDueToViolation(type) {
  disarmViolationMonitor();
  stopBoardTimer();
  exitFullscreenSafe();
  el("violation-warning-overlay").hidden = true;
  el("board-cancelled-reason").textContent = `Your paper was cancelled after 2 integrity warnings. Last flagged issue: ${
    VIOLATION_LABELS[type] || "an integrity issue"
  }. This is recorded on our server and cannot be undone from this device.`;
  showScreen("boardCancelled");
}

el("board-cancelled-retry-btn").addEventListener("click", () => {
  showScreen("boardSetup");
});

// ---------------------------------------------------------------
// Fullscreen helpers (cross-browser)
// ---------------------------------------------------------------
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function requestFullscreenSafe() {
  const target = document.documentElement;
  const fn = target.requestFullscreen || target.webkitRequestFullscreen;
  if (!fn) return Promise.reject(new Error("Fullscreen not supported"));
  return fn.call(target);
}

function exitFullscreenSafe() {
  if (!isFullscreen()) return;
  const fn = document.exitFullscreen || document.webkitExitFullscreen;
  if (fn) fn.call(document).catch(() => {});
}

// ---------------------------------------------------------------
// Photo upload + client-side compression + reordering
// ---------------------------------------------------------------
const photoInput = el("answer-photos");
const photoGrid = el("photo-grid");
const submitPhotosBtn = el("board-submit-photos-btn");
const boardUploadError = el("board-upload-error");

photoInput.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files || []);
  boardUploadError.hidden = true;

  for (const file of files) {
    if (boardState.photos.length >= MAX_PHOTOS) {
      boardUploadError.textContent = `You can upload up to ${MAX_PHOTOS} photos.`;
      boardUploadError.hidden = false;
      break;
    }
    try {
      const compressed = await resizeImageFile(file);
      boardState.photos.push(compressed);
    } catch (err) {
      console.error("Image processing failed:", err);
    }
  }

  photoInput.value = "";
  renderPhotoGrid();
});

function renderPhotoGrid() {
  photoGrid.innerHTML = "";
  boardState.photos.forEach((photo, i) => {
    const thumb = document.createElement("div");
    thumb.className = "photo-thumb";
    thumb.innerHTML = `
      <img src="${photo.dataUrl}" alt="Answer sheet page ${i + 1}" />
      <span class="photo-page-label">Page ${i + 1}</span>
      <div class="photo-controls">
        <button type="button" class="photo-move" data-dir="up" aria-label="Move earlier" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="photo-move" data-dir="down" aria-label="Move later" ${
          i === boardState.photos.length - 1 ? "disabled" : ""
        }>↓</button>
      </div>
      <button type="button" class="photo-remove" aria-label="Remove photo">×</button>
    `;
    thumb.querySelector(".photo-remove").addEventListener("click", () => {
      boardState.photos.splice(i, 1);
      renderPhotoGrid();
    });
    thumb.querySelectorAll(".photo-move").forEach((btn) => {
      btn.addEventListener("click", () => {
        const swapWith = btn.dataset.dir === "up" ? i - 1 : i + 1;
        if (swapWith < 0 || swapWith >= boardState.photos.length) return;
        [boardState.photos[i], boardState.photos[swapWith]] = [boardState.photos[swapWith], boardState.photos[i]];
        renderPhotoGrid();
      });
    });
    photoGrid.appendChild(thumb);
  });

  submitPhotosBtn.disabled = boardState.photos.length === 0;
}

/**
 * Resize + compress an image file client-side before sending it to the
 * Edge Function, so uploads stay small and fast even from phone cameras.
 */
function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve({
          dataUrl,
          mimeType: "image/jpeg",
          base64: dataUrl.split(",")[1],
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------
// Submit for checking (Edge Function #3 — GEMINI_API_KEY_CHECKER)
// ---------------------------------------------------------------
submitPhotosBtn.addEventListener("click", async () => {
  await evaluatePaper();
});

async function evaluatePaper() {
  boardState.attempt += 1;
  const isFinalAttempt = boardState.attempt >= MAX_UPLOAD_ATTEMPTS;

  showScreen("boardChecking");
  cycleLoadingText("board-checking-text", BOARD_CHECKING_LINES);

  const elapsedSeconds = boardState.meta.timerMinutes * 60 - Math.max(0, boardState.timer.remainingSeconds);

  try {
    const res = await fetchWithRetry(
      EVALUATE_PAPER_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          sessionId: boardState.sessionId,
          subject: boardState.meta.subject,
          className: boardState.meta.className,
          board: boardState.meta.board,
          questions: boardState.paper,
          // Sent strictly in the order the student arranged them: index 0 = Page 1, etc.
          images: boardState.photos.map((p) => ({ mimeType: p.mimeType, data: p.base64 })),
          isFinalAttempt,
        }),
      },
      {
        onRetry: ({ attempt, maxRetries, delayMs, reason }) => {
          el("board-checking-text").textContent = `Server's busy (${reason}) — retrying in ${Math.round(
            delayMs / 1000
          )}s… (${attempt}/${maxRetries})`;
        },
      }
    );

    const data = await res.json().catch(() => ({}));

    if (res.status === 403 && data.status === "session_cancelled") {
      stopLoadingCycle();
      el("board-cancelled-reason").textContent =
        data.error || "This exam session was cancelled due to repeated integrity violations and cannot be graded.";
      showScreen("boardCancelled");
      return;
    }

    if (!res.ok) {
      throw new Error(data.error || `Server responded with ${res.status}.`);
    }

    const evaluation = data;
    stopLoadingCycle();

    if (evaluation.status === "needs_clearer_image" && !isFinalAttempt) {
      el("unclear-message").textContent =
        evaluation.message || "One or more pages were hard to read. Please retake the photo(s) with better lighting and focus.";
      el("unclear-banner").hidden = false;
      showScreen("boardUpload");
      return;
    }

    const totalMarks = boardState.meta.totalMarks;
    const marksAwarded = clamp(Math.round(evaluation.totalMarksAwarded ?? 0), 0, totalMarks);
    const percent = Math.round((marksAwarded / totalMarks) * 100);

    const result = {
      id: `board_${Date.now()}`,
      date: new Date().toISOString(),
      topic: boardState.meta.chapter ? `${boardState.meta.subject} — ${boardState.meta.chapter}` : boardState.meta.subject,
      subject: boardState.meta.subject,
      chapter: boardState.meta.chapter,
      className: boardState.meta.className,
      board: boardState.meta.board,
      totalMarks,
      marksAwarded,
      percent,
      timeTakenSeconds: elapsedSeconds,
      perQuestion: Array.isArray(evaluation.perQuestion) ? evaluation.perQuestion : [],
      strengths: Array.isArray(evaluation.strengths) ? evaluation.strengths : [],
      improvements: Array.isArray(evaluation.improvements) ? evaluation.improvements : [],
      questions: boardState.paper.map((q) => ({ id: q.id, section: q.section, marks: q.marks, questionText: q.questionText })),
      wasUnclear: evaluation.status === "needs_clearer_image",
    };

    saveResultToHistory(result, "board");
    renderBoardResults(result);
    showScreen("boardResults");
  } catch (err) {
    console.error(err);
    stopLoadingCycle();
    showScreen("boardUpload");
    boardUploadError.textContent =
      "Couldn't check your answer sheet right now (" + (err.message || "unknown error") + "). Please try again.";
    boardUploadError.hidden = false;
  }
}

// ---------------------------------------------------------------
// Results
// ---------------------------------------------------------------
function renderBoardResults(result) {
  el("board-results-title").textContent =
    result.percent >= 80 ? "Excellent answer sheet!" : result.percent >= 50 ? "Solid attempt!" : "Room to grow!";
  el("board-score-fraction").textContent = `${result.marksAwarded}/${result.totalMarks}`;
  el("board-score-percent").textContent = `${result.percent}%`;

  const circumference = 2 * Math.PI * 60;
  const offset = circumference - (result.percent / 100) * circumference;
  const ring = el("board-ring-fill");
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference}`;
  requestAnimationFrame(() => {
    ring.style.strokeDashoffset = `${offset}`;
  });
  ring.style.stroke =
    result.percent >= 80 ? "var(--mint-500)" : result.percent >= 50 ? "var(--gold-500)" : "var(--coral-500)";

  const feedbackCard = el("board-feedback-card");
  const strengthsHtml = result.strengths.length
    ? `<div class="feedback-block"><h4>What went well</h4><ul>${result.strengths
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}</ul></div>`
    : "";
  const improvementsHtml = result.improvements.length
    ? `<div class="feedback-block"><h4>Improve next time</h4><ul>${result.improvements
        .map((s) => `<li>${escapeHtml(s)}</li>`)
        .join("")}</ul></div>`
    : "";
  const unclearHtml = result.wasUnclear
    ? `<p class="unclear-note">Some parts of your handwriting were hard to read, so a couple of marks are a best estimate. Write a little larger and darker next time for a more accurate check.</p>`
    : "";

  feedbackCard.innerHTML = `${unclearHtml}${strengthsHtml}${improvementsHtml}`;

  const reviewList = el("board-review-list");
  reviewList.innerHTML = "";
  let currentSection = null;
  result.questions.forEach((q, i) => {
    if (q.section && q.section !== currentSection) {
      currentSection = q.section;
      const meta = SECTION_META[currentSection] || { title: `Section ${currentSection}` };
      const heading = document.createElement("p");
      heading.className = "section-heading review-section-heading";
      heading.textContent = meta.title;
      reviewList.appendChild(heading);
    }
    const feedback = result.perQuestion.find((p) => p.id === q.id) || {};
    const item = document.createElement("div");
    item.className = "board-review-item";
    item.innerHTML = `
      <div class="paper-question-head">
        <span class="question-index">Q${i + 1}</span>
        <span class="marks-badge">${feedback.marksAwarded ?? 0} / ${q.marks}</span>
      </div>
      <p class="question-text">${escapeHtml(q.questionText)}</p>
      ${feedback.feedback ? `<p class="explanation">${escapeHtml(feedback.feedback)}</p>` : ""}
    `;
    reviewList.appendChild(item);
  });
}

el("board-retake-btn").addEventListener("click", () => {
  boardForm.reset();
  boardMarksGroup.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-selected"));
  boardMarksGroup.querySelector('[data-value="20"]').classList.add("is-selected");
  boardTotalMarksInput.value = "20";
  boardTimerInput.value = "40";
  showScreen("boardSetup");
});

// ---------------------------------------------------------------
// Small utils local to board.js
// ---------------------------------------------------------------
let loadingCycleInterval = null;

function cycleLoadingText(elementId, lines) {
  stopLoadingCycle();
  let idx = 0;
  el(elementId).textContent = lines[0];
  loadingCycleInterval = setInterval(() => {
    idx = (idx + 1) % lines.length;
    el(elementId).textContent = lines[idx];
  }, 1800);
}

function stopLoadingCycle() {
  clearInterval(loadingCycleInterval);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
