# ChalkQuiz — Setup & Deployment Guide

This guide walks you through deploying ChalkQuiz from zero to a live URL. It now has two AI-powered modes:

- **Practice Quiz** — multiple-choice quizzes by grade, topic, and difficulty (5/10/15/20 questions).
- **Board Exam Simulator** — for students preparing for Indian board exams (CBSE/ICSE/State Board). The AI writes a subjective, hand-written-style question paper (10/15/20 marks) with an internal marking scheme, the student writes their answers on paper under a timer, photographs the answer sheet, and the AI grades it like a board examiner — with step marking and improvement notes.

It uses:

- **HTML / CSS / JavaScript** — the frontend (no framework, no build step)
- **Google AI Studio (Gemini API)** — three separate API keys, one per AI task (see below)
- **Supabase Edge Functions** — three small server-side proxies that call Gemini, so no API key is ever exposed in the browser
- **GitHub** — stores your code
- **Netlify** — hosts the static frontend and auto-deploys from GitHub

**Total time:** ~30–40 minutes, no prior backend experience required.

---

## Architecture overview

Three independent Gemini API keys power three Edge Functions, matching the three distinct AI jobs in the app:

```
Practice Quiz
Browser ──POST {topic, grade, difficulty, numQuestions}──▶ generate-quiz Edge Function
                                                              (secret: GEMINI_API_KEY)
                                                              ──▶ Gemini ──▶ MCQ quiz JSON ──▶ Browser

Board Exam Simulator — step 1: set the paper
Browser ──POST {subject, className, board, totalMarks}──▶ generate-paper Edge Function
                                                              (secret: GEMINI_API_KEY_PAPER)
                                                              ──▶ Gemini ──▶ questions + marking scheme ──▶ Browser
                                                                                 (student writes on paper, timer runs)

Board Exam Simulator — step 2: check the answer sheet
Browser ──POST {questions, markingScheme, photo(s)}──▶ evaluate-paper Edge Function
                                                              (secret: GEMINI_API_KEY_CHECKER)
                                                              ──▶ Gemini Vision ──▶ marks + feedback ──▶ Browser
                                                                 (or "photo unclear, please retake")
```

None of the three Gemini API keys ever appear in your HTML/JS, browser network tab, or GitHub repo. Only the Supabase project URL and the public "anon" key are in the frontend — those are designed to be public and only allow calling your functions, nothing else.

**Why three separate keys instead of one?** Splitting quiz generation, paper generation, and answer-sheet grading across three keys keeps each feature's usage and quota independent — if one key gets rate-limited or you want to track costs per feature in Google AI Studio, the others keep working. If you'd rather keep it simple, you can reuse the same key value for all three secrets — the app works either way.

All **results** (both practice quizzes and board exam attempts) are saved with `localStorage` directly in the student's browser — no database needed for that part.

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
   - the whole `supabase` folder (drag the folder itself — GitHub's uploader preserves the folder structure, so `supabase/functions/generate-quiz/index.ts`, `supabase/functions/generate-paper/index.ts`, `supabase/functions/evaluate-paper/index.ts`, and `supabase/config.toml` will all land in the right place)

   > Tip: if your browser lets you select multiple items at once (folder + files together), do it in one drag so everything uploads together. Otherwise, upload the files first, then drag in the `supabase` folder separately — GitHub will merge it into the existing repo.
4. Scroll down, add a commit message like `Initial commit: ChalkQuiz`, and click **Commit changes**.
5. Refresh the repository page and confirm you see all the files, including the three nested `index.ts` files under `supabase/functions/`.

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

   These two values are safe to commit — they are meant to be public. They only let the browser call your Edge Functions, not read your secrets. (`config.js` already includes the URLs for all three functions — `generate-quiz`, `generate-paper`, and `evaluate-paper` — you only need to fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY`.)

---

## Step 4 — Deploy the three Edge Functions and store your Gemini keys as secrets

You now have three functions to deploy, each with its own secret:

| Function | Secret name | What it does |
|---|---|---|
| `generate-quiz` | `GEMINI_API_KEY` | Generates MCQ practice quizzes |
| `generate-paper` | `GEMINI_API_KEY_PAPER` | Generates the board-exam question paper + marking scheme |
| `evaluate-paper` | `GEMINI_API_KEY_CHECKER` | Grades the photographed answer sheet against the marking scheme |

> **No terminal? Use the Supabase Dashboard.** Repeat these steps three times, once per function above:
> 1. In your Supabase project, go to **Edge Functions** in the left sidebar → **Deploy a new function** → **Via editor**.
> 2. Name it exactly as shown in the table (`generate-quiz`, `generate-paper`, or `evaluate-paper`).
> 3. On GitHub, open the matching file — `supabase/functions/generate-quiz/index.ts`, `supabase/functions/generate-paper/index.ts`, or `supabase/functions/evaluate-paper/index.ts` — click **Raw**, select all, and copy it.
> 4. Paste it into the Supabase dashboard's code editor for that function, replacing the placeholder content, then click **Deploy**.
> 5. Under the function's settings, make sure **Enforce JWT Verification** is turned **off** for all three — this matches `verify_jwt = false` in `supabase/config.toml`, since the app calls these functions without a logged-in user.
>
> Once all three are deployed, go to **Edge Functions → Secrets** (or **Project Settings → Edge Functions → Secrets**) and add all three secrets from the table above, pasting in the matching Gemini API key from Step 1 for each. Save.
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

4. Deploy all three functions:

   ```bash
   supabase functions deploy generate-quiz
   supabase functions deploy generate-paper
   supabase functions deploy evaluate-paper
   ```

5. Confirm they deployed: in the Supabase dashboard, go to **Edge Functions** — you should see all three listed as active.

> The included `supabase/config.toml` sets `verify_jwt = false` for all three functions, since the app calls them directly from the browser without a logged-in user. Your Gemini keys are still fully protected — that setting only controls who can *call the function*, not who can see the secrets inside it.

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
  -d '{"subject":"Physics","className":"Class 10","board":"CBSE","totalMarks":15,"timerMinutes":23}'
```

You should get back JSON with a `questions` array in both cases. `evaluate-paper` is easiest to test from the app itself in Step 7, since it needs a real photo.

---

## Step 5 — Push your `config.js` update to GitHub

```bash
git add config.js
git commit -m "Add Supabase project config"
git push
```

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

From now on, every `git push` to `main` automatically redeploys the site.

---

## Step 7 — Try it out

**Practice Quiz:**
1. Open your Netlify URL.
2. Fill in a topic, grade, difficulty, and number of questions (5/10/15/20), set or disable the timer, and click **Generate quiz**.
3. Answer the questions, submit, and view your score and answer review.

**Board Exam Simulator:**
1. Click **Board Exam** in the top nav.
2. Fill in a subject, class, board, and total marks (10/15/20), adjust the timer if you like, and click **Generate question paper**.
3. Write your answers by hand on paper, numbering them to match the question numbers shown.
4. When you're done (or the timer runs out), click **I'm done — upload answer sheet**, then photograph your page(s) in good light and submit.
5. If a photo is too blurry or unreadable, the AI will ask you to retake it (up to 3 attempts) instead of guessing at your marks.
6. Review your marks, examiner feedback, and question-by-question breakdown.

Click **History** in the top nav for either mode — past attempts are listed under separate "Practice quizzes" / "Board exams" tabs, pulled from `localStorage` on that device/browser.

---

## Troubleshooting

**"Couldn't generate a quiz / question paper right now" error in the app**
- Open your browser's dev tools → Network tab, retry, and check the response from `generate-quiz` or `generate-paper`.
- Common causes: `config.js` still has placeholder values, the matching Edge Function secret wasn't set, or that Gemini API key is invalid/over quota.

**"Couldn't check your answer sheet right now" error**
- Check the `evaluate-paper` response in the Network tab. Common causes: `GEMINI_API_KEY_CHECKER` not set, the photo file was too large (see below), or a temporary Gemini API error — retrying usually works.

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
├── app.js                              # Practice quiz logic, shared nav/history helpers
├── board.js                            # Board Exam Simulator: paper, timer, photo upload, grading
├── config.js                           # Public Supabase URL + anon key + function endpoints
├── netlify.toml                        # Netlify hosting config
├── .gitignore
├── SETUP.md                            # You are here
└── supabase/
    ├── config.toml                     # Edge Function auth settings
    └── functions/
        ├── generate-quiz/
        │   └── index.ts                # MCQ practice quiz (secret: GEMINI_API_KEY)
        ├── generate-paper/
        │   └── index.ts                # Board exam paper + marking scheme (secret: GEMINI_API_KEY_PAPER)
        └── evaluate-paper/
            └── index.ts                # Photo grading against marking scheme (secret: GEMINI_API_KEY_CHECKER)
```

---

## Extending this project

- **Add real user accounts:** enable Supabase Auth and store quiz/board exam results in a Postgres table instead of (or alongside) `localStorage`, so results follow the student across devices.
- **Teacher dashboard:** create Supabase tables for quiz and board exam results, insert a row from the frontend after each attempt (using the anon key with row-level security scoped to the student's user id), and build a simple teacher view — especially useful for board exam attempts, where a teacher may want to spot-check the AI's grading.
- **Store the marking scheme server-side:** for this prototype, the marking scheme travels through the browser between paper generation and evaluation (kept in memory, never displayed). For a stricter setup, save it in a Supabase table keyed by a session id when `generate-paper` runs, and have `evaluate-paper` look it up server-side instead of trusting what the client sends back.
- **Rate limiting:** add a check in the Edge Functions (e.g. by IP or user id) to prevent abuse of your Gemini quota — image grading calls are the most expensive of the three.
- **More question types:** extend the Gemini prompts and schemas to support true/false, fill-in-the-blank, or diagram-based questions.
