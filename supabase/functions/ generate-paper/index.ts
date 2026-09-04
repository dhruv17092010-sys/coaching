// ============================================================
// generate-paper — Supabase Edge Function
// ------------------------------------------------------------
// Receives { subject, chapter, className, board, totalMarks,
// timerMinutes } and asks Gemini for a subjective (write-on-paper)
// question paper in the style of Indian school board exams
// (CBSE/ICSE/State Board), along with an internal step-marking
// scheme used later by evaluate-paper.
//
// Deploy with:
//   supabase functions deploy generate-paper
// Set the secret with:
//   supabase secrets set GEMINI_API_KEY_PAPER=your-key-here
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY_PAPER");
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_MARKS = [10, 15, 20];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!GEMINI_API_KEY) {
    return jsonResponse(
      { error: "Server is missing GEMINI_API_KEY_PAPER. Set it with `supabase secrets set GEMINI_API_KEY_PAPER=...`." },
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
  const chapter = String(body.chapter ?? "").trim();
  const className = String(body.className ?? "").trim();
  const boardName = String(body.board ?? "CBSE").trim();
  const totalMarksRaw = Number(body.totalMarks ?? 15);
  const totalMarks = ALLOWED_MARKS.includes(totalMarksRaw) ? totalMarksRaw : 15;

  if (!subject || subject.length > 80) {
    return jsonResponse({ error: "A valid 'subject' (1-80 chars) is required." }, 400);
  }
  if (!className) {
    return jsonResponse({ error: "A 'className' is required." }, 400);
  }

  const prompt = buildPrompt({ subject, chapter, className, boardName, totalMarks });

  try {
    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
          responseSchema: paperSchema(),
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return jsonResponse({ error: "Could not parse the AI's response as JSON." }, 502);
    }

    const questions = (parsed as { questions?: unknown })?.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
      return jsonResponse({ error: "The AI did not return any questions." }, 502);
    }

    // Normalize + assign stable ids so the frontend and evaluate-paper agree on question identity.
    const normalized = questions.map((q: any, i: number) => ({
      id: String(i + 1),
      marks: Math.max(1, Math.round(Number(q.marks) || 1)),
      questionText: String(q.questionText || "").trim(),
      markingScheme: {
        criteria: Array.isArray(q.markingScheme?.criteria)
          ? q.markingScheme.criteria.map((c: any) => ({
              point: String(c.point || "").trim(),
              marks: Math.max(0, Number(c.marks) || 0),
            }))
          : [],
        modelAnswer: String(q.markingScheme?.modelAnswer || "").trim(),
      },
    }));

    return jsonResponse({ questions: normalized });
  } catch (err) {
    console.error("Unhandled error calling Gemini:", err);
    return jsonResponse({ error: "Unexpected server error. Please try again." }, 500);
  }
});

function buildPrompt(opts: { subject: string; chapter: string; className: string; boardName: string; totalMarks: number }) {
  const { subject, chapter, className, boardName, totalMarks } = opts;
  return `You are a senior examiner setting a ${boardName} board exam question paper for ${className} in India.

Subject: ${subject}
${chapter ? `Chapter / topic focus: ${chapter}` : "Chapter / topic focus: cover a reasonable spread of the standard syllabus for this subject and class."}
Total marks for this paper: ${totalMarks}

Write a subjective (long-form, hand-written-answer) question paper worth EXACTLY ${totalMarks} marks total, in the style and difficulty typical of real ${boardName} board exam papers for ${className}. Requirements:
- Mix question weights realistically (e.g. some 1-2 mark short-answer questions, some 3 mark questions, some 5 mark long-answer questions), the way a real board paper is structured — do not make every question worth the same marks.
- The sum of all "marks" values across questions must equal exactly ${totalMarks}.
- Question text should be clear, exam-appropriate wording a real student would recognize, and should NOT include the answer.
- For each question, also produce an internal marking scheme (never shown to the student) with:
  - "criteria": a list of specific points/steps that earn marks (e.g. "correctly states Newton's second law: 1 mark", "correct final numerical answer with units: 1 mark"), where the marks across all criteria for a question sum to that question's total marks.
  - "modelAnswer": a concise model answer/solution an examiner would use as reference while grading.
- Favor a mix of question types appropriate to the subject (definitions, short explanations, numericals/derivations for science/math, structured essay-style points for humanities, etc).
- Do not repeat the same concept twice across questions.
- Return ONLY the structured data — no extra commentary.`;
}

function paperSchema() {
  return {
    type: "OBJECT",
    properties: {
      questions: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            marks: { type: "INTEGER" },
            questionText: { type: "STRING" },
            markingScheme: {
              type: "OBJECT",
              properties: {
                criteria: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      point: { type: "STRING" },
                      marks: { type: "NUMBER" },
                    },
                    required: ["point", "marks"],
                  },
                },
                modelAnswer: { type: "STRING" },
              },
              required: ["criteria", "modelAnswer"],
            },
          },
          required: ["marks", "questionText", "markingScheme"],
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
