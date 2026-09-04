// ============================================================
// ChalkQuiz — board.js
// Board Exam Simulator: subjective question paper -> timed
// handwritten answers -> photo upload -> AI grading.
// Relies on shared helpers (el, escapeHtml, showScreen, formatTime,
// getHistory, saveResultToHistory, renderHistory) defined in app.js,
// which loads before this file.
// ============================================================

const MAX_UPLOAD_ATTEMPTS = 3;
const MAX_PHOTOS = 6;
const MAX_IMAGE_DIMENSION = 1600;

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

const boardState = {
  meta: { subject: "", chapter: "", className: "", board: "CBSE", totalMarks: 15, timerMinutes: 23 },
  paper: /** @type {{id:string, marks:number, questionText:string, markingScheme:any}[]} */ ([]),
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
  boardTimerInput.value = String(Math.round(marks * 1.5));
});

boardForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  boardFormError.hidden = true;

  const subject = el("board-subject").value.trim();
  const chapter = el("board-chapter").value.trim();
  const className = el("board-class").value;
  const boardType = el("board-type").value;
  const totalMarks = parseInt(boardTotalMarksInput.value, 10);
  const timerMinutes = Math.max(5, parseInt(boardTimerInput.value, 10) || 20);

  if (!subject || !className) {
    boardFormError.textContent = "Please fill in a subject and class.";
    boardFormError.hidden = false;
    return;
  }

  boardState.meta = { subject, chapter, className, board: boardType, totalMarks, timerMinutes };
  boardState.attempt = 0;
  boardState.photos = [];

  await generatePaper();
});

// ---------------------------------------------------------------
// Generate paper (Edge Function #2 — GEMINI_API_KEY_PAPER)
// ---------------------------------------------------------------
async function generatePaper() {
  showScreen("boardLoading");
  cycleLoadingText("board-loading-text", BOARD_LOADING_LINES);

  try {
    const res = await fetch(GENERATE_PAPER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(boardState.meta),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Server responded with ${res.status}. ${text}`);
    }

    const data = await res.json();
    const questions = Array.isArray(data.questions) ? data.questions : [];

    if (!questions.length) throw new Error("The AI didn't return any usable questions.");

    boardState.paper = questions;
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
// Writing screen + timer
// ---------------------------------------------------------------
function startBoardPaper() {
  el("board-paper-label").textContent = `${boardState.meta.subject} · ${boardState.meta.className} · ${boardState.meta.board}`;
  el("board-paper-marks").textContent = `${boardState.meta.totalMarks} marks`;

  const container = el("paper-questions");
  container.innerHTML = "";
  boardState.paper.forEach((q, i) => {
    const item = document.createElement("div");
    item.className = "paper-question";
    item.innerHTML = `
      <div class="paper-question-head">
        <span class="question-index">Q${i + 1}</span>
        <span class="marks-badge">${q.marks} mark${q.marks === 1 ? "" : "s"}</span>
      </div>
      <p class="question-text">${escapeHtml(q.questionText)}</p>
    `;
    container.appendChild(item);
  });

  showScreen("boardPaper");
  startBoardTimer(boardState.meta.timerMinutes * 60);
}

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
  stopBoardTimer();
  goToUploadScreen();
});

function goToUploadScreen() {
  stopBoardTimer();
  el("unclear-banner").hidden = true;
  showScreen("boardUpload");
  renderPhotoGrid();
}

// ---------------------------------------------------------------
// Photo upload + client-side compression
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
      <button type="button" class="photo-remove" aria-label="Remove photo">×</button>
    `;
    thumb.querySelector(".photo-remove").addEventListener("click", () => {
      boardState.photos.splice(i, 1);
      renderPhotoGrid();
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
    const res = await fetch(EVALUATE_PAPER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        subject: boardState.meta.subject,
        className: boardState.meta.className,
        board: boardState.meta.board,
        questions: boardState.paper,
        images: boardState.photos.map((p) => ({ mimeType: p.mimeType, data: p.base64 })),
        isFinalAttempt,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Server responded with ${res.status}. ${text}`);
    }

    const evaluation = await res.json();
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
      questions: boardState.paper.map((q) => ({ id: q.id, marks: q.marks, questionText: q.questionText })),
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
  result.questions.forEach((q, i) => {
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
  boardMarksGroup.querySelector('[data-value="15"]').classList.add("is-selected");
  boardTotalMarksInput.value = "15";
  boardTimerInput.value = "23";
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
