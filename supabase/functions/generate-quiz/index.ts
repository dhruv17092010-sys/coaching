// ============================================================
// generate-quiz — Supabase Edge Function
// ------------------------------------------------------------
// Receives { topic, grade, difficulty, numQuestions } from the
// browser, calls Google Gemini using a secret API key that is
// stored ONLY in Supabase's server-side environment (never sent
// to the client), and returns a normalized quiz JSON payload.
//
// Deploy with:
//   supabase functions deploy generate-quiz
// Set the secret with:
//   supabase secrets set GEMINI_API_KEY=your-key-here
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// gemini-2.0-flash was retired in June 2026. gemini-3.6-flash is the
// current stable model as of August 2026 (gemini-3.7-flash is newer
// but still promotionally priced/rolling out — swap in if you prefer it).
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_DIFFICULTIES = ["Easy", "Medium", "Hard"];
const ALLOWED_COUNTS = [5, 10, 15, 20];

serve(async (req) => {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!GEMINI_API_KEY) {
    return jsonResponse(
      { error: "Server is missing GEMINI_API_KEY. Set it with `supabase secrets set GEMINI_API_KEY=...`." },
      500
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const topic = String(body.topic ?? "").trim();
  const grade = String(body.grade ?? "").trim();
  const difficulty = String(body.difficulty ?? "Medium").trim();
  const numQuestionsRaw = Number(body.numQuestions ?? 10);
  const numQuestions = ALLOWED_COUNTS.includes(numQuestionsRaw) ? numQuestionsRaw : 10;
  const safeDifficulty = ALLOWED_DIFFICULTIES.includes(difficulty) ? difficulty : "Medium";

  if (!topic || topic.length > 120) {
    return jsonResponse({ error: "A valid 'topic' (1-120 chars) is required." }, 400);
  }
  if (!grade) {
    return jsonResponse({ error: "A 'grade' is required." }, 400);
  }

  const prompt = buildPrompt({ topic, grade, difficulty: safeDifficulty, numQuestions });

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.8,
          responseMimeType: "application/json",
          responseSchema: quizSchema(numQuestions),
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini API error:", geminiRes.status, errText);
      return jsonResponse({ error: "The AI provider returned an error. Please try again." }, 502);
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      return jsonResponse({ error: "The AI returned an empty response." }, 502);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return jsonResponse({ error: "Could not parse the AI's response as JSON." }, 502);
    }

    const questions = Array.isArray(parsed) ? parsed : (parsed as { questions?: unknown })?.questions;

    if (!Array.isArray(questions) || questions.length === 0) {
      return jsonResponse({ error: "The AI did not return any questions." }, 502);
    }

    return jsonResponse({ questions });
  } catch (err) {
    console.error("Unhandled error calling Gemini:", err);
    return jsonResponse({ error: "Unexpected server error. Please try again." }, 500);
  }
});

function buildPrompt(opts: { topic: string; grade: string; difficulty: string; numQuestions: number }) {
  const { topic, grade, difficulty, numQuestions } = opts;
  return `You are an expert teacher creating a multiple-choice quiz for a student.

Topic: ${topic}
Grade / level: ${grade}
Difficulty: ${difficulty}
Number of questions: ${numQuestions}

Write exactly ${numQuestions} multiple-choice questions about the topic above, calibrated to the stated grade level and difficulty. Requirements:
- Each question must have exactly 4 answer options.
- Exactly one option is correct.
- Vary which option index is correct across questions (don't always put the correct answer first).
- Keep questions age-appropriate and factually accurate for the given grade level.
- Include a short one-sentence explanation of why the correct answer is right.
- Do not repeat questions or trivially rephrase the same question twice.
- Return ONLY the structured data — no extra commentary.`;
}

function quizSchema(numQuestions: number) {
  return {
    type: "OBJECT",
    properties: {
      questions: {
        type: "ARRAY",
        minItems: numQuestions,
        maxItems: numQuestions,
        items: {
          type: "OBJECT",
          properties: {
            question: { type: "STRING" },
            options: {
              type: "ARRAY",
              minItems: 4,
              maxItems: 4,
              items: { type: "STRING" },
            },
            correctIndex: { type: "INTEGER" },
            explanation: { type: "STRING" },
          },
          required: ["question", "options", "correctIndex", "explanation"],
        },
      },
    },
    required: ["questions"],
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
