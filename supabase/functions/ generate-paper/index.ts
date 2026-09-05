// ============================================================
// generate-paper — Supabase Edge Function
// ------------------------------------------------------------
// Receives { subject, chapter, className, board, totalMarks }
// and asks Gemini for a sectioned board-exam question paper:
//   Section A — MCQs               (~1/8 of total marks)
//   Section B — Case study/source-based questions (~3/20 of total marks)
//   Section C — Short & long answer subjective questions (remainder)
// along with an internal step-marking scheme, used later by
// evaluate-paper.
//
// Also creates a row in `exam_sessions` (via the service_role key,
// bypassing RLS) so the anti-cheating warning system in the frontend
// has a server-side session to report violations against. See
// supabase/sql/exam_sessions.sql for the table definition.
//
// Deploy with:
//   supabase functions deploy generate-paper
// Set the secret with:
//   supabase secrets set GEMINI_API_KEY_PAPER=your-key-here
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by
// Supabase into every Edge Function — no need to set those yourself.)
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY_PAPER");
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_MARKS = [10, 20, 40, 50, 70, 80];

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
  const totalMarksRaw = Number(body.totalMarks ?? 20);
  const totalMarks = ALLOWED_MARKS.includes(totalMarksRaw) ? totalMarksRaw : 20;

  if (!subject || subject.length > 80) {
    return jsonResponse({ error: "A valid 'subject' (1-80 chars) is required." }, 400);
  }
  if (!className) {
    return jsonResponse({ error: "A 'className' is required." }, 400);
  }

  const sections = computeSectionMarks(totalMarks);

  try {
    const questions = await generateQuestionsWithRetry({ subject, chapter, className, boardName, totalMarks, sections });

    if (!questions.length) {
      return jsonResponse({ error: "The AI did not return any questions." }, 502);
    }

    let sessionId: string | null = null;
    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      sessionId = await createExamSession({ subject, className, boardName, totalMarks });
    } else {
      console.warn(
        "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not available — exam session was not created. Anti-cheat warnings will be disabled for this paper."
      );
    }

    return jsonResponse({ questions, sessionId, sections });
  } catch (err) {
    console.error("Unhandled error in generate-paper:", err);
    return jsonResponse({ error: (err as Error).message || "Unexpected server error. Please try again." }, 502);
  }
});

// ---------------------------------------------------------------
// Section mark allocation
// ---------------------------------------------------------------
function computeSectionMarks(totalMarks: number) {
  const mcqCount = Math.max(1, Math.round(totalMarks / 8));
  const mcqMarks = mcqCount; // 1 mark per MCQ, matching board exam convention
  let caseStudyMarks = Math.round((totalMarks * 3) / 20);
  let subjectiveMarks = totalMarks - mcqMarks - caseStudyMarks;

  if (subjectiveMarks < 0) {
    caseStudyMarks = Math.max(0, totalMarks - mcqMarks);
    subjectiveMarks = totalMarks - mcqMarks - caseStudyMarks;
  }

  return { mcqCount, mcqMarks, caseStudyMarks, subjectiveMarks };
}

// ---------------------------------------------------------------
// Gemini call with one corrective retry if the mark total is off
// ---------------------------------------------------------------
async function generateQuestionsWithRetry(opts: {
  subject: string;
  chapter: string;
  className: string;
  boardName: string;
  totalMarks: number;
  sections: ReturnType<typeof computeSectionMarks>;
}) {
  let questions = await callGemini(buildPrompt(opts));
  const actualTotal = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  if (actualTotal !== opts.totalMarks) {
    const correctivePrompt =
      buildPrompt(opts) +
      `\n\nIMPORTANT CORRECTION: your previous attempt summed to ${actualTotal} marks instead of exactly ${opts.totalMarks}. Recount carefully and make sure every question's "marks" value is included, and the grand total across ALL sections equals exactly ${opts.totalMarks}.`;
    try {
      const retried = await callGemini(correctivePrompt);
      const retriedTotal = retried.reduce((sum, q) => sum + (q.marks || 0), 0);
      if (retriedTotal === opts.totalMarks || Math.abs(retriedTotal - opts.totalMarks) < Math.abs(actualTotal - opts.totalMarks)) {
        questions = retried;
      }
    } catch {
      // fall back to the first (imperfect) attempt rather than failing outright
    }
  }

  return questions;
}

async function callGemini(promptText: string) {
  const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: promptText }] }],
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
    throw new Error(`The AI provider returned an error (${geminiRes.status}). Please try again.`);
  }

  const geminiData = await geminiRes.json();
  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("The AI returned an empty response.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("Could not parse the AI's response as JSON.");
  }

  const questions = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(questions)) throw new Error("The AI response did not include a questions array.");

  return questions.map((q: any, i: number) => ({
    id: String(i + 1),
    section: ["A", "B", "C"].includes(q.section) ? q.section : "C",
    type: ["mcq", "case_study", "short_answer", "long_answer"].includes(q.type) ? q.type : "short_answer",
    marks: Math.max(1, Math.round(Number(q.marks) || 1)),
    questionText: String(q.questionText || "").trim(),
    passage: String(q.passage || "").trim(),
    options: Array.isArray(q.options) ? q.options.map((o: any) => String(o).trim()) : [],
    correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : -1,
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
}

// ---------------------------------------------------------------
// Exam session (anti-cheat) — created via service_role, bypasses RLS
// ---------------------------------------------------------------
async function createExamSession(opts: { subject: string; className: string; boardName: string; totalMarks: number }) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/exam_sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        subject: opts.subject,
        class_name: opts.className,
        board: opts.boardName,
        total_marks: opts.totalMarks,
      }),
    });
    if (!res.ok) {
      console.error("Failed to create exam session:", res.status, await res.text());
      return null;
    }
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
  } catch (err) {
    console.error("Error creating exam session:", err);
    return null;
  }
}

// ---------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------
function buildPrompt(opts: {
  subject: string;
  chapter: string;
  className: string;
  boardName: string;
  totalMarks: number;
  sections: ReturnType<typeof computeSectionMarks>;
}) {
  const { subject, chapter, className, boardName, totalMarks, sections } = opts;
  const { mcqCount, mcqMarks, caseStudyMarks, subjectiveMarks } = sections;

  return `You are a senior examiner setting a ${boardName} board exam question paper for ${className} in India.

Subject: ${subject}
${chapter ? `Chapter / topic focus: ${chapter}` : "Chapter / topic focus: cover a reasonable spread of the standard syllabus for this subject and class."}
Total marks for this paper: EXACTLY ${totalMarks}

Write a competency-based board exam paper split into exactly three sections. Favor competency-based / applied-thinking questions (real-world application, reasoning, analysis) over pure rote recall, matching the current direction of CBSE/ICSE competency-based assessment.

SECTION A — Multiple Choice Questions (objective)
- Exactly ${mcqCount} MCQs, each worth exactly 1 mark (${mcqMarks} marks total).
- Each MCQ needs exactly 4 options and one correct option (give its 0-based index as "correctIndex").
- Prefer application/reasoning-based MCQs over pure definition recall, in the style of real ${boardName} objective sections.
- section: "A", type: "mcq" for every question in this section. Leave "passage" as an empty string.

SECTION B — Case Study / Source-Based Questions
- Case-study or source-based questions totaling EXACTLY ${caseStudyMarks} marks. Use 1 or 2 case studies depending on how many marks fit naturally (e.g. one ${caseStudyMarks}-mark case study, or two smaller ones).
- Each case study question object should have a short "passage" (a paragraph, data snippet, or source extract relevant to the subject/chapter — e.g. a short unseen passage for languages, a data table or graph description for science/economics, a source excerpt for history/civics) and a "questionText" listing 2-4 numbered sub-questions based on that passage, each sub-question's mark value noted in parentheses, summing to that question object's total "marks".
- section: "B", type: "case_study". Leave "options" empty and "correctIndex" as -1.

SECTION C — Short & Long Answer Questions
- Subjective short/long-answer questions totaling EXACTLY ${subjectiveMarks} marks, mixing question weights realistically (e.g. some 2 mark questions, some 3 mark, some 5 mark), the way a real board paper is structured — do not make every question worth the same marks.
- section: "C", type: "short_answer" for questions worth up to 3 marks, "long_answer" for questions worth 4+ marks. Leave "passage" empty, "options" empty, "correctIndex" as -1.

General requirements for ALL questions:
- The sum of "marks" across ALL questions in ALL sections must equal EXACTLY ${totalMarks}.
- Question text should be clear, exam-appropriate wording a real student would recognize, and should NOT reveal the answer.
- For each question, also produce an internal marking scheme (never shown to the student) with:
  - "criteria": a list of specific points/steps that earn marks (for MCQs, a single criterion like "Selects the correct option" worth the full mark; for others, itemized marking points), where the marks across all criteria for a question sum to that question's total marks.
  - "modelAnswer": a concise model answer/solution (for MCQs, state the correct option letter and a one-line reason) an examiner would use as reference while grading.
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
            section: { type: "STRING", enum: ["A", "B", "C"] },
            type: { type: "STRING", enum: ["mcq", "case_study", "short_answer", "long_answer"] },
            marks: { type: "INTEGER" },
            questionText: { type: "STRING" },
            passage: { type: "STRING" },
            options: { type: "ARRAY", items: { type: "STRING" } },
            correctIndex: { type: "INTEGER" },
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
          required: ["section", "type", "marks", "questionText", "markingScheme"],
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
