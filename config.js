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

const SUPABASE_URL = "https://wxcqxviocsyprmxzwnyl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_QBiGef7ozcb4QeNJIx8rfg_g273NQOq";

// Full URL of the deployed Edge Function that talks to Gemini.
const GENERATE_QUIZ_ENDPOINT = `${SUPABASE_URL}/functions/v1/generate-quiz`;
