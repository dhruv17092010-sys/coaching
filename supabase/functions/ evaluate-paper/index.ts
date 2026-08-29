// ============================================================
// evaluate-paper — Supabase Edge Function
// ------------------------------------------------------------
// Receives { subject, className, board, questions (with marking
// schemes), images: [{mimeType, data(base64)}], isFinalAttempt }.
// Sends the photo(s) + marking scheme to Gemini's vision-capable
// model, which reads the handwriting, grades it like a board
// examiner (step marking), and returns per-question marks +
// feedback. If the writing/photo is too unclear to grade fairly,
// and this isn't the student's final allowed attempt, it asks for
// a clearer photo instead of guessing.
//
// Deploy with:
//   supabase functions deploy evaluate-paper
// Set the secret with:
//   supabase secrets set GEMINI_API_KEY_CHECKER=your-key-here
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY_CHECKER");
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_IMAGES = 6;
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!GEMINI_API_KEY) {
    return jsonResponse(
      { error: "Server is missing GEMINI_API_KEY_CHECKER. Set it with `supabase secrets set GEMINI_API_KEY_CHECKER=...`." },
      500
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const subject = String(body.subject ?? "").trim();
  const className = String(body.className ?? "").trim();
  const boardName = String(body.board ?? "CBSE").trim();
  const questions = Array.isArray(body.questions) ? body.questions : [];
  const images = Array.isArray(body.images) ? body.images : [];
  const isFinalAttempt = Boolean(body.isFinalAttempt);

  if (!questions.length) {
    return jsonResponse({ error: "No questions/marking scheme provided." }, 400);
  }
  if (!images.length) {
    return jsonResponse({ error: "At least one answer sheet photo is required." }, 400);
  }
  if (images.length > MAX_IMAGES) {
    return jsonResponse({ error: `Too many images. Maximum is ${MAX_IMAGES}.` }, 400);
  }
  for (const img of images) {
    if (!ALLOWED_MIME_TYPES.includes(String((img as any)?.mimeType))) {
      return jsonResponse({ error: "Unsupported image type. Use JPEG, PNG, or WebP." }, 400);
    }
  }

  const totalMarks = questions.reduce((sum: number, q: any) => sum + (Number(q.marks) || 0), 0);
  const prompt = buildPrompt({ subject, className, boardName, questions, totalMarks, isFinalAttempt });

  const imageParts = (images as { mimeType: string; data: string }[]).map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, ...imageParts],
          },
        ],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: evaluationSchema(),
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
    if (!rawText) return jsonResponse({ error: "The AI returned an empty response." }, 502);

    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return jsonResponse({ error: "Could not parse the AI's response as JSON." }, 502);
    }

    const status = parsed.status === "needs_clearer_image" && !isFinalAttempt ? "needs_clearer_image" : "ok";

    return jsonResponse({
      status,
      message: String(parsed.message || ""),
      totalMarksAwarded: clamp(Number(parsed.totalMarksAwarded) || 0, 0, totalMarks),
      perQuestion: Array.isArray(parsed.perQuestion)
        ? parsed.perQuestion.map((p: any) => ({
            id: String(p.id ?? ""),
            marksAwarded: Math.max(0, Number(p.marksAwarded) || 0),
            feedback: String(p.feedback || ""),
          }))
        : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.map(String) : [],
    });
  } catch (err) {
    console.error("Unhandled error calling Gemini:", err);
    return jsonResponse({ error: "Unexpected server error. Please try again." }, 500);
  }
});

function buildPrompt(opts: {
  subject: string;
  className: string;
  boardName: string;
  questions: any[];
  totalMarks: number;
  isFinalAttempt: boolean;
}) {
  const { subject, className, boardName, questions, totalMarks, isFinalAttempt } = opts;

  const schemeText = questions
    .map((q, i) => {
      const criteria = (q.markingScheme?.criteria || [])
        .map((c: any) => `    - ${c.point} (${c.marks} mark${c.marks === 1 ? "" : "s"})`)
        .join("\n");
      return `Q${i + 1} [id: ${q.id}] — ${q.marks} marks
  Question: ${q.questionText}
  Marking criteria:
${criteria || "    (no itemized criteria provided — grade against the model answer)"}
  Model answer: ${q.markingScheme?.modelAnswer || "(none provided)"}`;
    })
    .join("\n\n");

  const clarityInstruction = isFinalAttempt
    ? `This is the student's final allowed attempt at uploading a photo, so you MUST grade as best you can even if some handwriting is unclear — never return "needs_clearer_image" on this attempt. If parts are genuinely illegible, award 0 for that specific point and say so plainly in that question's feedback.`
    : `If the photo(s) are too blurry, too dark, cropped, or the handwriting is genuinely too illegible to grade fairly for one or more questions, set "status" to "needs_clearer_image" and explain specifically which question number(s) or page(s) are the problem in "message" — be specific and actionable (e.g. "Q3's answer on page 2 is cut off at the bottom — please include the full page"). Only do this when grading would genuinely be unfair or a guess; minor untidy handwriting that is still readable should just be graded normally.`;

  return `You are a strict but fair ${boardName} board exam examiner in India, grading a ${className} ${subject} answer sheet worth ${totalMarks} marks total.

The student answered the following questions by hand on paper, and you are given photo(s) of their answer sheet. Match each handwritten answer to its question by the number the student wrote (they were told to number answers to match the question list).

${schemeText}

Grading instructions:
- Use step/partial marking exactly like a real board examiner: award marks for each correct step, fact, or criterion reached, even if the final answer is wrong. Do not require a perfect answer for partial credit.
- Do not penalize for messy handwriting itself, only for content that is actually incorrect, missing, or illegible.
- For numerical/derivation answers, give marks for correct method even if there's a small arithmetic slip, per the marking criteria.
- If the student attempted a question not fully per the marking scheme but demonstrated valid alternative correct reasoning, still award appropriate marks.
- If a question was left completely blank, award 0 and note it was not attempted.
- ${clarityInstruction}
- Write "feedback" for each question as 1-2 short sentences a teacher would actually say to the student — specific to what they wrote, not generic.
- "strengths" and "improvements" should be 2-4 short bullet-style sentences each, specific to this answer sheet, covering the paper as a whole (e.g. recurring mistakes, good structure, missing units, time management if visible from how much was completed).
- Return ONLY the structured JSON — no extra commentary outside the schema.`;
}

function evaluationSchema() {
  return {
    type: "OBJECT",
    properties: {
      status: { type: "STRING", enum: ["ok", "needs_clearer_image"] },
      message: { type: "STRING" },
      totalMarksAwarded: { type: "NUMBER" },
      perQuestion: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            marksAwarded: { type: "NUMBER" },
            feedback: { type: "STRING" },
          },
          required: ["id", "marksAwarded", "feedback"],
        },
      },
      strengths: { type: "ARRAY", items: { type: "STRING" } },
      improvements: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["status", "totalMarksAwarded", "perQuestion", "strengths", "improvements"],
  };
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
