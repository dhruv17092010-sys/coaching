// ============================================================
// ChalkQuiz — public client configuration
// ============================================================
// These two values are SAFE to expose in the browser.
// The Supabase "anon" key only allows calling your Edge Function;
// it cannot read your Gemini API key, which stays on the server
// side inside Supabase's encrypted secrets store.
//
// Fill these in after you create your Supabase project — see
// SETUP.md, Step 3.
// ============================================================

const SUPABASE_URL = "https://iqxagbtrrxexmyypipyw.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable__q3zDoPqiwHhpuhJhwP-ig_Yczrh0mZ";

// Full URL of the deployed Edge Function that talks to Gemini.
const GENERATE_QUIZ_ENDPOINT = `${SUPABASE_URL}/functions/v1/generate-quiz`;

// Board Exam Simulator endpoints (see SETUP.md, "Board Exam Simulator" section).
const GENERATE_PAPER_ENDPOINT = `${SUPABASE_URL}/functions/v1/generate-paper`;
const EVALUATE_PAPER_ENDPOINT = `${SUPABASE_URL}/functions/v1/evaluate-paper`;
