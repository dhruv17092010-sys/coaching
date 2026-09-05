# ChalkQuiz — Setup & Deployment Guide

This guide walks you through deploying ChalkQuiz from zero to a live URL. It has two AI-powered modes:

- **Practice Quiz** — multiple-choice quizzes by grade, topic, and difficulty (5/10/15/20 questions).
- **Board Exam Simulator** — for students preparing for Indian board exams (CBSE/ICSE/State Board). The AI writes a competency-based, sectioned question paper (10/20/40/50/70/80 marks) with an internal marking scheme, the student writes their answers on paper under a full-screen timer with server-enforced exam integrity monitoring, photographs the answer sheet in page order, and the AI grades it like a board examiner — with step marking and improvement notes.

Board Exam papers are split into three sections, matching real board exam structure:
- **Section A — MCQs**, worth ~1/8 of the total marks (e.g. 10 MCQs on an 80-mark paper).
- **Section B — Case study / source-based questions**, worth ~3/20 of the total marks.
- **Section C — Short & long answer questions**, the remainder, in varied mark weights.

It uses:

- **HTML / CSS / JavaScript** — the frontend (no framework, no build step)
- **Google AI Studio (Gemini API)** — three separate API keys, one per AI task (see below)
- **Supabase Edge Functions** — four small server-side proxies (three call Gemini, one manages exam integrity), so no API key is ever exposed in the browser
- **Supabase Postgres** — a small `exam_sessions` table that makes the anti-cheating warning system tamper-resistant (see Upgrade 3 below)
- **GitHub** — stores your code
- **Netlify** — hosts the static frontend and auto-deploys from GitHub

Two upgrades work quietly in the background on every AI call:
- **Exponential backoff:** if Gemini returns a 503 ("model overloaded") or similar transient error, the app automatically retries with increasing delays (1s, 2s, 4s...) up to 5 times before giving up, so brief traffic spikes on Google's side don't fail the student's request outright.
- **Exam integrity monitoring:** while writing a board exam paper, the app runs in full-screen and watches for tab switches, lost window focus, and attempts to exit full-screen or close/reload the tab. Two violations cancel the paper — and that decision is made by Supabase, not by the browser, so it can't be undone by editing the site's JavaScript. See Upgrade 3 below for exactly what this can and can't detect.

**Total time:** ~40–50 minutes, no prior backend experience required.

---

## Architecture overview

Three independent Gemini API keys power three Edge Functions, matching the three distinct AI jobs in the app. A fourth Edge Function (no Gemini key needed) manages exam integrity via a Postgres table:

```
Practice Quiz
Browser ──POST {topic, grade, difficulty, numQuestions}──▶ generate-quiz Edge Function
                                                              (secret: GEMINI_API_KEY)
                                                              ──▶ Gemini ──▶ MCQ quiz JSON ──▶ Browser

Board Exam Simulator — step 1: set the paper
Browser ──POST {subject, className, board, totalMarks}──▶ generate-paper Edge Function
                                                              (secret: GEMINI_API_KEY_PAPER)
                                                              ──▶ Gemini ──▶ sectioned questions + marking scheme
                                                              ──▶ creates a row in exam_sessions (service_role)
                                                              ──▶ questions + sessionId ──▶ Browser
                                                                 (student writes on paper, full-screen timer runs)

Board Exam Simulator — during the exam: integrity monitoring
Browser (fullscreenchange / visibilitychange / blur / keydown / beforeunload)
        ──POST {sessionId, violationType}──▶ report-violation Edge Function
                                                              ──▶ Postgres function report_violation()
                                                                  atomically increments warnings, cancels at 2
                                                              ──▶ {warnings, status} ──▶ Browser

Board Exam Simulator — step 2: check the answer sheet
Browser ──POST {sessionId, questions, markingScheme, photo(s) in page order}──▶ evaluate-paper Edge Function
                                                              (secret: GEMINI_API_KEY_CHECKER)
                                                              ──▶ checks exam_sessions.status (service_role);
                                                                  refuses to grade if "cancelled"
                                                              ──▶ Gemini Vision ──▶ marks + feedback ──▶ Browser
                                                                 (or "photo unclear, please retake")
```

None of the three Gemini API keys ever appear in your HTML/JS, browser network tab, or GitHub repo. Only the Supabase project URL and the public "anon" key are in the frontend — those are designed to be public and only allow calling your functions, nothing else.

**Why three separate keys instead of one?** Splitting quiz generation, paper generation, and answer-sheet grading across three keys keeps each feature's usage and quota independent — if one key gets rate-limited or you want to track costs per feature in Google AI Studio, the others keep working. If you'd rather keep it simple, you can reuse the same key value for all three secrets — the app works either way.

**Why is the anti-cheat warning count stored in Supabase instead of just a JavaScript variable?** Because a JavaScript variable lives entirely in the student's browser — a student who opens dev tools could simply set it back to 0. The `exam_sessions` table has Row Level Security enabled with **no policies for the public anon key**, so the browser cannot read or write it directly at all, even with full knowledge of the site's source code. The only way to change a session's warning count is through the `report-violation` Edge Function, which uses the `service_role` key (never sent to the browser) to call a Postgres function that atomically increments the count and cancels the session. `evaluate-paper` re-checks this same authoritative record before grading, so even a fully rewritten frontend can't get a cancelled paper graded.

All **results** (both practice quizzes and board exam attempts) are saved with `localStorage` directly in the student's browser — no database needed for that part.

### What the exam integrity monitor can and can't detect

Being upfront about this matters, since you asked for something that specifically resists tampering:

**What it reliably detects:**
- Exiting full-screen mode.
- Switching to another tab or app (the exam tab becomes hidden).
- The browser window losing OS-level focus (e.g. alt-tabbing, opening another app, opening a side panel that steals focus).
- Pressing common new-tab/close-tab shortcuts (Ctrl/Cmd+T, +N, +W) — the keystroke itself is observable even though browsers don't let a webpage actually block the action.
- Attempting to close or reload the tab (best-effort; a native "are you sure you want to leave?" prompt also appears).

**What it cannot detect, and why:**
- **Which specific app, panel, or browser feature (e.g. a browser's built-in AI side panel) the student switched to.** Browsers deliberately don't expose that level of detail to webpages, for the same privacy reasons they don't tell any other website what else is open on your computer. The monitor knows the student *left*, not *where they went*.
- **OS-level shortcuts like Alt+Tab, or actually closing the browser application itself.** These happen outside the browser's control and aren't observable by JavaScript at all.
- **A student who disables the monitor before starting.** This is a client-side script; someone comfortable with browser dev tools could, in principle, prevent these listeners from ever running, which means no violations get reported at all. What Supabase *does* guarantee is that once a violation **is** reported, the count and cancellation decision can't be tampered with after the fact — it closes the "reset my own warning count" loophole, not the "prevent my browser from telling on me" one.

If you need stronger guarantees than a website can provide (e.g. for a real graded exam), that requires either a dedicated lockdown/proctoring browser, a browser extension with elevated permissions, an LMS integration, or live webcam invigilation — genuinely different tools from what a plain web page can do. This system is best framed as an honest deterrent for a self-practice tool, not exam-hall-grade proctoring.

---

## Step 1 — Get three Google AI Studio (Gemini) API keys

1. Go to [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. Sign in with a Google account.
3. Click **Create API key** three times (you can create multiple keys in the same project, or use "Create API key in new project" for extra separation). Label them as you create them, e.g. `chalkquiz-quiz`, `chalkquiz-paper`, `chalkquiz-checker`, so you don't mix them up.
4. Copy all three keys somewhere safe. You will paste them into Supabase in Step 4 — **not** into any file in this project.

---

## Step 2 — Create a GitHub repository (using github.com, no terminal needed)

1. Go to [https://github.com/new](https://github.com/new) and create a new repository (e.g. `chalkquiz`). Keep it public or private — either works with Netlify. Do **not** initialize it with a README (you're uploading your own files).
2. On the new repository's page, click **uploading an existing file** (or go to **Add file → Upload files**).
3. From this project folder, drag in all the top-level files and folders:
   - `index.html`
   - `style.css`
   - `app.js`
   - `board.js`
   - `config.js`
   - `netlify.toml`
   - `.gitignore`
   - `SETUP.md`
   - the whole `supabase` folder (drag the folder itself — GitHub's uploader preserves the folder structure, so `supabase/functions/generate-quiz/index.ts`, `supabase/functions/generate-paper/index.ts`, `supabase/functions/evaluate-paper/index.ts`, `supabase/functions/report-violation/index.ts`, `supabase/sql/exam_sessions.sql`, and `supabase/config.toml` will all land in the right place)

   > Tip: if your browser lets you select multiple items at once (folder + files together), do it in one drag so everything uploads together. Otherwise, upload the files first, then drag in the `supabase` folder separately — GitHub will merge it into the existing repo.
4. Scroll down, add a commit message like `Initial commit: ChalkQuiz`, and click **Commit changes**.
5. Refresh the repository page and confirm you see all the files, including the four nested `index.ts` files under `supabase/functions/` and `supabase/sql/exam_sessions.sql`.

---

## Step 3 — Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
   - Pick an organization, name (e.g. `chalkquiz`), a database password (save it somewhere), and a region close to your users.
3. Wait ~1–2 minutes for the project to finish provisioning.
4. In the project dashboard, go to **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (a long string starting with `eyJ...`)
5. Open `config.js` — you can edit it either locally before uploading in Step 2, or directly on GitHub:
   - In your repository on github.com, click `config.js`.
   - Click the pencil (✎) **Edit this file** icon in the top-right of the file view.
   - Replace the placeholder values:

     ```js
     const SUPABASE_URL = "https://abcdefgh.supabase.co";
     const SUPABASE_ANON_KEY = "eyJ...your-anon-key...";
     ```

   - Scroll down, add a commit message like `Add Supabase project config`, and click **Commit changes** (committing straight to `main` is fine for this project).

   These two values are safe to commit — they are meant to be public. They only let the browser call your Edge Functions, not read your secrets. (`config.js` already includes the URLs for all four functions — `generate-quiz`, `generate-paper`, `evaluate-paper`, and `report-violation` — you only need to fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`.)

---

## Step 4 — Set up the anti-cheat database

This creates the `exam_sessions` table and the `report_violation` Postgres function that make the exam integrity warnings tamper-resistant.

1. In your Supabase project, go to **SQL Editor** in the left sidebar → **New query**.
2. On GitHub, open `supabase/sql/exam_sessions.sql`, click **Raw**, select all, and copy it.
3. Paste it into the SQL Editor and click **Run**.
4. You should see a success message. Confirm the table exists: go to **Table Editor** in the sidebar — you should see `exam_sessions` listed with columns `id`, `status`, `warnings`, etc.

> If you skip this step, the app still works, but the anti-cheat warning system is silently inactive (no session gets created, so no violations can be recorded). Everything else — paper generation, writing, photo upload, grading — works exactly the same either way.

---

## Step 5 — Deploy the four Edge Functions and store your Gemini keys as secrets

You now have four functions to deploy. Three need a Gemini API key; `report-violation` only needs Supabase's own auto-injected credentials:

| Function | Secret name | What it does |
|---|---|---|
| `generate-quiz` | `GEMINI_API_KEY` | Generates MCQ practice quizzes |
| `generate-paper` | `GEMINI_API_KEY_PAPER` | Generates the sectioned board-exam question paper + marking scheme, and creates the exam session row |
| `evaluate-paper` | `GEMINI_API_KEY_CHECKER` | Grades the photographed answer sheet, after checking the session wasn't cancelled |
| `report-violation` | *(none needed)* | Atomically records an integrity violation and returns the updated warning count/status |

> **No terminal? Use the Supabase Dashboard.** Repeat these steps four times, once per function above:
> 1. In your Supabase project, go to **Edge Functions** in the left sidebar → **Deploy a new function** → **Via editor**.
> 2. Name it exactly as shown in the table (`generate-quiz`, `generate-paper`, `evaluate-paper`, or `report-violation`).
> 3. On GitHub, open the matching file — e.g. `supabase/functions/report-violation/index.ts` — click **Raw**, select all, and copy it.
> 4. Paste it into the Supabase dashboard's code editor for that function, replacing the placeholder content, then click **Deploy**.
> 5. Under the function's settings, make sure **Enforce JWT Verification** is turned **off** for all four — this matches `verify_jwt = false` in `supabase/config.toml`, since the app calls these functions without a logged-in user.
>
> Once all four are deployed, go to **Edge Functions → Secrets** (or **Project Settings → Edge Functions → Secrets**) and add the three Gemini secrets from the table above (skip `report-violation` — it needs no secret of its own; `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already available to every function automatically). Save.
>
> That's it — skip straight to "Test the functions directly" below. The CLI steps that follow are only needed if you'd rather work from a terminal.

### CLI method (optional alternative)

1. Install the Supabase CLI:

   ```bash
   npm install -g supabase
   ```

   (or via Homebrew: `brew install supabase/tap/supabase`)

2. Log in and link the CLI to your project:

   ```bash
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   ```

   Your project ref is the subdomain part of your Project URL (e.g. `abcdefgh` from `https://abcdefgh.supabase.co`). You can also copy it from **Project Settings → General**.

3. Store all three Gemini API keys as encrypted secrets:

   ```bash
   supabase secrets set GEMINI_API_KEY=your-quiz-key-here
   supabase secrets set GEMINI_API_KEY_PAPER=your-paper-key-here
   supabase secrets set GEMINI_API_KEY_CHECKER=your-checker-key-here
   ```

4. Push the anti-cheat SQL (instead of the SQL Editor route in Step 4 above):

   ```bash
   supabase db push --file supabase/sql/exam_sessions.sql
   ```

   (Or paste its contents into **SQL Editor → New query → Run** in the dashboard, same as the no-CLI instructions in Step 4.)

5. Deploy all four functions:

   ```bash
   supabase functions deploy generate-quiz
   supabase functions deploy generate-paper
   supabase functions deploy evaluate-paper
   supabase functions deploy report-violation
   ```

6. Confirm they deployed: in the Supabase dashboard, go to **Edge Functions** — you should see all four listed as active.

> The included `supabase/config.toml` sets `verify_jwt = false` for all four functions, since the app calls them directly from the browser without a logged-in user. Your Gemini keys are still fully protected — that setting only controls who can *call the function*, not who can see the secrets inside it.

### Test the functions directly (optional but recommended)

```bash
curl -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/generate-quiz" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR-ANON-KEY" \
  -H "apikey: YOUR-ANON-KEY" \
  -d '{"topic":"Photosynthesis","grade":"Grade 7","difficulty":"Medium","numQuestions":5}'

curl -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/generate-paper" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR-ANON-KEY" \
  -H "apikey: YOUR-ANON-KEY" \
  -d '{"subject":"Physics","className":"Class 10","board":"CBSE","totalMarks":20}'
```

You should get back JSON with a `questions` array (and a `sessionId`, if Step 4's SQL was run) in both cases. `evaluate-paper` and `report-violation` are easiest to test from the app itself in Step 7, since they need a real photo and a real session id respectively.

---

## Step 6 — Deploy the frontend on Netlify

1. Go to [https://app.netlify.com](https://app.netlify.com) and sign in (you can sign in with GitHub).
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub** and select your `chalkquiz` repository.
4. Build settings — this project has no build step, so:
   - **Build command:** leave blank
   - **Publish directory:** `.` (project root)
   - (These are also pre-filled by the included `netlify.toml`.)
5. Click **Deploy site**. Netlify will give you a live URL like `https://chalkquiz-123abc.netlify.app`.
6. (Optional) Rename it under **Site configuration → Change site name**, or attach a custom domain.

From now on, every commit to `main` on GitHub automatically redeploys the site.

---

## Step 7 — Try it out

**Practice Quiz:**
1. Open your Netlify URL.
2. Fill in a topic, grade, difficulty, and number of questions (5/10/15/20), set or disable the timer, and click **Generate quiz**.
3. Answer the questions, submit, and view your score and answer review.

**Board Exam Simulator:**
1. Click **Board Exam** in the top nav.
2. Fill in a subject, class, board, and total marks (10/20/40/50/70/80), adjust the timer if you like, and click **Generate question paper**.
3. Read the full-screen notice, then click **Start exam in full-screen**. You'll see three sections: MCQs, case study/source-based questions, and short/long answer questions.
4. Write your answers by hand on paper, numbering them to match the question numbers shown. Try switching tabs or pressing Escape to leave full-screen — you should see a warning overlay ("warning 1 of 2"); do it again and the paper should cancel automatically.
5. On a fresh attempt, when you're done (or the timer runs out), click **I'm done — upload answer sheet**, then photograph your page(s) in good light, in the order you wrote them (reorder with the ↑/↓ buttons if needed), and submit.
6. If a photo is too blurry or unreadable, the AI will ask you to retake it (up to 3 attempts) instead of guessing at your marks.
7. Review your marks, examiner feedback, and question-by-question breakdown.

Click **History** in the top nav for either mode — past attempts are listed under separate "Practice quizzes" / "Board exams" tabs, pulled from `localStorage` on that device/browser.

---

## Troubleshooting

**"Couldn't generate a quiz / question paper right now" error in the app**
- Open your browser's dev tools → Network tab, retry, and check the response from `generate-quiz` or `generate-paper`.
- Common causes: `config.js` still has placeholder values, the matching Edge Function secret wasn't set, or that Gemini API key is invalid/over quota.

**"Couldn't check your answer sheet right now" error**
- Check the `evaluate-paper` response in the Network tab. Common causes: `GEMINI_API_KEY_CHECKER` not set, the photo file was too large (see below), or a temporary Gemini API error — retrying usually works.

**Getting a lot of 503 errors from Gemini ("model overloaded")**
- The app already retries these automatically with exponential backoff (1s, 2s, 4s, 8s, up to 5 attempts) — you'll see the loading text update with "Server's busy — retrying in Xs…" during this. If it still fails after all retries, Google's API is genuinely overloaded at that moment; waiting a minute and trying again usually works. You can tune the retry count/delays via the `maxRetries`/`baseDelayMs` options passed to `fetchWithRetry(...)` in `app.js`/`board.js`.

**The paper gets cancelled for no obvious reason / warnings trigger too easily**
- This usually means something is stealing window focus that isn't actually the student cheating — e.g. a screen-reader, a notification popup, or certain browser extensions. There's a 4-second cooldown between recorded violations (`VIOLATION_COOLDOWN_MS` in `board.js`) to avoid double-counting a single event, but if false positives are common in your environment, you can loosen the `onWindowBlur` listener (the most sensitive of the checks) or remove it entirely — see the "What it reliably detects" list earlier in this doc.

**"Start exam in full-screen" doesn't work / does nothing**
- Some browsers block full-screen requests unless they're triggered directly by a click (this app already does that correctly) or if the site isn't served over HTTPS — Netlify serves over HTTPS by default, so this is mainly an issue when testing locally over plain `http://`. Try the deployed Netlify URL instead of a local file.

**Warnings aren't being tracked at all (chip never appears, violations never cancel anything)**
- This means no `sessionId` was returned by `generate-paper` — almost always because Step 4's SQL wasn't run yet, or `report-violation` wasn't deployed. Check the `generate-paper` response in the Network tab for a `sessionId` field, and check that function's logs in the Supabase dashboard for a warning about missing `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_URL` (these should be automatic, but a very old Supabase project might need them added manually as regular secrets — see [Supabase's Edge Function secrets docs](https://supabase.com/docs/guides/functions/secrets) if so).

**`supabase functions deploy` fails with an auth error**
- Run `supabase login` again, and make sure `supabase link` used the correct project ref.

**CORS errors in the browser console**
- Make sure you deployed the functions from this repo as-is — they already send the required `Access-Control-Allow-Origin` headers.

**Error like `"This model models/gemini-2.0-flash is no longer available"`**
- Google periodically retires older Gemini models. Open the relevant `index.ts` file (`generate-quiz`, `generate-paper`, or `evaluate-paper`), find the `GEMINI_MODEL` constant near the top, and update it to whatever current model name Google's error message (or the [models list](https://ai.google.dev/gemini-api/docs/models)) points you to — e.g. `gemini-3.6-flash`. Re-deploy that function afterward.

**Gemini returns malformed JSON / no questions**
- This is rare because the functions request structured JSON output, but if it happens, just retry — occasionally the model needs a second attempt for very obscure topics.

**The AI keeps saying the photo is unclear**
- Make sure the whole page is in frame, in good even light, with no shadows across the writing, and the phone held roughly parallel to the page. After 3 attempts the app grades with whatever it can read rather than looping forever, and flags any best-effort marks in the results.

**Photo upload fails or times out**
- Supabase Edge Functions have a request body size limit. The app already resizes photos client-side (max 1600px, JPEG ~80% quality) before upload to stay well under it, but very many high-resolution pages at once can still add up — try uploading 1–2 pages at a time if this happens, or lower `MAX_IMAGE_DIMENSION` in `board.js`.

**Quiz or board exam history disappeared**
- `localStorage` is per-browser and per-device. Clearing browser data, using a different browser, or private/incognito mode will not show old history. This is expected, since the app intentionally avoids storing student results in any external database.

---

## Project structure

```
chalkquiz/
├── index.html                          # App shell: all quiz + board exam screens
├── style.css                           # Chalkboard-themed styling
├── app.js                              # Practice quiz logic, shared nav/history/backoff helpers
├── board.js                            # Board Exam Simulator: paper, anti-cheat monitor, photo upload, grading
├── config.js                           # Public Supabase URL + anon key + function endpoints
├── netlify.toml                        # Netlify hosting config
├── .gitignore
├── SETUP.md                            # You are here
└── supabase/
    ├── config.toml                     # Edge Function auth settings
    ├── sql/
    │   └── exam_sessions.sql           # Anti-cheat table + report_violation() Postgres function
    └── functions/
        ├── generate-quiz/
        │   └── index.ts                # MCQ practice quiz (secret: GEMINI_API_KEY)
        ├── generate-paper/
        │   └── index.ts                # Sectioned board exam paper + marking scheme + session creation (secret: GEMINI_API_KEY_PAPER)
        ├── evaluate-paper/
        │   └── index.ts                # Photo grading, session-cancellation check (secret: GEMINI_API_KEY_CHECKER)
        └── report-violation/
            └── index.ts                # Atomic anti-cheat warning increment (no Gemini secret needed)
```

---

## Extending this project

- **Add real user accounts:** enable Supabase Auth and store quiz/board exam results in a Postgres table instead of (or alongside) `localStorage`, so results follow the student across devices. This would also let you attach `exam_sessions` rows to a real student id instead of an anonymous session.
- **Teacher dashboard:** create Supabase tables for quiz and board exam results, insert a row from the frontend after each attempt (using the anon key with row-level security scoped to the student's user id), and build a simple teacher view — especially useful for board exam attempts, where a teacher may want to spot-check the AI's grading or review cancelled sessions (`exam_sessions` already has everything needed for the latter — `status`, `warnings`, `last_violation`).
- **Store the marking scheme server-side:** for this prototype, the marking scheme travels through the browser between paper generation and evaluation (kept in memory, never displayed). For a stricter setup, save it in a Supabase table (you could extend `exam_sessions` with a `questions` jsonb column) keyed by the session id when `generate-paper` runs, and have `evaluate-paper` look it up server-side instead of trusting what the client sends back.
- **Stronger exam proctoring:** as covered above, a website's JavaScript has real limits on what it can detect. If you need more than a deterrent, look at a lockdown browser (e.g. Safe Exam Browser), a proctoring browser extension with camera/screen access, or an LMS integration with live invigilation.
- **Rate limiting:** add a check in the Edge Functions (e.g. by IP or user id) to prevent abuse of your Gemini quota — image grading calls are the most expensive.
- **More question types:** extend the Gemini prompts and schemas to support true/false, fill-in-the-blank, or diagram-based questions.
