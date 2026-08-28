# ChalkQuiz — Setup & Deployment Guide

This guide walks you through deploying ChalkQuiz from zero to a live URL. It uses:

- **HTML / CSS / JavaScript** — the frontend (no framework, no build step)
- **Google AI Studio (Gemini API)** — generates the quiz questions
- **Supabase Edge Function** — a small server-side proxy that calls Gemini, so your API key is never exposed in the browser
- **GitHub** — stores your code
- **Netlify** — hosts the static frontend and auto-deploys from GitHub

**Total time:** ~20–30 minutes, no prior backend experience required.

---

## Architecture overview

```
Browser (index.html/app.js)
        │  POST { topic, grade, difficulty, numQuestions }
        ▼
Supabase Edge Function (generate-quiz)
        │  uses secret GEMINI_API_KEY (stored server-side only)
        ▼
Google Gemini API
        │  returns quiz JSON
        ▼
Supabase Edge Function → Browser
```

The Gemini API key **never** appears in your HTML/JS, browser network tab, or GitHub repo. Only the Supabase project URL and the public "anon" key are in the frontend — those are designed to be public and only allow calling your function, nothing else.

Quiz **results** are saved with `localStorage` directly in the student's browser — no database needed for that part.

---

## Step 1 — Get a Google AI Studio (Gemini) API key

1. Go to [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. Sign in with a Google account.
3. Click **Create API key** (choose "Create API key in new project" if you don't have one).
4. Copy the key somewhere safe. You will paste it into Supabase in Step 4 — **not** into any file in this project.

---

## Step 2 — Create a GitHub repository

1. Go to [https://github.com/new](https://github.com/new) and create a new repository (e.g. `chalkquiz`). Keep it public or private — either works with Netlify.
2. On your computer, open a terminal in this project folder and push it:

   ```bash
   git init
   git add .
   git commit -m "Initial commit: ChalkQuiz"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/chalkquiz.git
   git push -u origin main
   ```

---

## Step 3 — Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New project**.
   - Pick an organization, name (e.g. `chalkquiz`), a database password (save it somewhere), and a region close to your users.
3. Wait ~1–2 minutes for the project to finish provisioning.
4. In the project dashboard, go to **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (a long string starting with `eyJ...`)
5. Open `config.js` in this project and paste them in:

   ```js
   const SUPABASE_URL = "https://abcdefgh.supabase.co";
   const SUPABASE_ANON_KEY = "eyJ...your-anon-key...";
   ```

   These two values are safe to commit — they are meant to be public. They only let the browser call your Edge Function, not read your secrets.

---

## Step 4 — Deploy the Edge Function and store your Gemini key as a secret

The Edge Function lives in `supabase/functions/generate-quiz/index.ts`. This is the piece that keeps your Gemini API key secret.

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

3. Store your Gemini API key as an encrypted secret (this is the step that keeps it out of your code entirely):

   ```bash
   supabase secrets set GEMINI_API_KEY=your-gemini-api-key-here
   ```

4. Deploy the function:

   ```bash
   supabase functions deploy generate-quiz
   ```

5. Confirm it deployed: in the Supabase dashboard, go to **Edge Functions** — you should see `generate-quiz` listed as active.

> The included `supabase/config.toml` sets `verify_jwt = false` for this function, since the quiz app calls it directly from the browser without a logged-in user. Your Gemini key is still fully protected — that setting only controls who can *call the function*, not who can see the secret inside it.

### Test the function directly (optional but recommended)

```bash
curl -X POST "https://YOUR-PROJECT-REF.supabase.co/functions/v1/generate-quiz" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR-ANON-KEY" \
  -H "apikey: YOUR-ANON-KEY" \
  -d '{"topic":"Photosynthesis","grade":"Grade 7","difficulty":"Medium","numQuestions":5}'
```

You should get back JSON like `{"questions":[{...}, ...]}`.

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

1. Open your Netlify URL.
2. Fill in a topic, grade, difficulty, and number of questions (5/10/15/20), set or disable the timer, and click **Generate quiz**.
3. Answer the questions, submit, and view your score and answer review.
4. Click **History** in the top nav — your past attempts are listed, pulled from `localStorage` on that device/browser.

---

## Troubleshooting

**"Couldn't generate a quiz right now" error in the app**
- Open your browser's dev tools → Network tab, retry, and check the response from `generate-quiz`.
- Common causes: `config.js` still has placeholder values, the Edge Function secret wasn't set, or the Gemini API key is invalid/over quota.

**`supabase functions deploy` fails with an auth error**
- Run `supabase login` again, and make sure `supabase link` used the correct project ref.

**CORS errors in the browser console**
- Make sure you deployed the function from this repo as-is — it already sends the required `Access-Control-Allow-Origin` headers.

**Gemini returns malformed JSON / no questions**
- This is rare because the function requests structured JSON output, but if it happens, just retry — occasionally the model needs a second attempt for very obscure topics.

**Quiz history disappeared**
- `localStorage` is per-browser and per-device. Clearing browser data, using a different browser, or private/incognito mode will not show old history. This is expected, since the app intentionally avoids storing student results in any external database.

---

## Project structure

```
chalkquiz/
├── index.html                          # App shell: setup, quiz, results, history screens
├── style.css                           # Chalkboard-themed styling
├── app.js                              # Frontend logic, timer, scoring, localStorage
├── config.js                           # Public Supabase URL + anon key (safe to expose)
├── netlify.toml                        # Netlify hosting config
├── .gitignore
├── SETUP.md                            # You are here
└── supabase/
    ├── config.toml                     # Edge Function auth settings
    └── functions/
        └── generate-quiz/
            └── index.ts                # Server-side proxy to Gemini (holds the secret key)
```

---

## Extending this project

- **Add real user accounts:** enable Supabase Auth and store quiz results in a Postgres table instead of (or alongside) `localStorage`, so results follow the student across devices.
- **Teacher dashboard:** create a Supabase table `quiz_results`, insert a row from the frontend after each quiz (using the anon key with row-level security scoped to the student's user id), and build a simple teacher view.
- **Rate limiting:** add a check in the Edge Function (e.g. by IP or user id) to prevent abuse of your Gemini quota.
- **More question types:** extend the Gemini prompt and schema in `index.ts` to support true/false or short-answer questions.
