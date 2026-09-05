// ============================================================
// report-violation — Supabase Edge Function
// ------------------------------------------------------------
// Receives { sessionId, violationType } from the frontend anti-cheat
// monitor and atomically increments the warning count for that exam
// session via the `report_violation` Postgres function (see
// supabase/sql/exam_sessions.sql). On the 2nd violation, the session
// is marked "cancelled" — this happens inside the database, not in
// browser JavaScript, so it can't be undone by editing the site's
// client-side code.
//
// Deploy with:
//   supabase functions deploy report-violation
// No extra secret needed — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are auto-injected by Supabase into every Edge Function.
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_VIOLATION_TYPES = [
  "exited_fullscreen",
  "tab_hidden_or_switched",
  "window_lost_focus",
  "attempted_tab_or_window_shortcut",
  "attempted_close_or_reload",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Server is missing Supabase service credentials." }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const sessionId = String(body.sessionId ?? "");
  const violationType = String(body.violationType ?? "");

  if (!UUID_RE.test(sessionId)) {
    return jsonResponse({ error: "A valid 'sessionId' is required." }, 400);
  }
  if (!ALLOWED_VIOLATION_TYPES.includes(violationType)) {
    return jsonResponse({ error: "Unrecognized violation type." }, 400);
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/report_violation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_session_id: sessionId, p_violation_type: violationType }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("report_violation RPC failed:", res.status, errText);
      return jsonResponse({ error: "Could not record the violation." }, 502);
    }

    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : rows;

    if (!row) {
      return jsonResponse({ error: "Exam session not found." }, 404);
    }

    return jsonResponse({ warnings: row.warnings, status: row.status });
  } catch (err) {
    console.error("Unhandled error in report-violation:", err);
    return jsonResponse({ error: "Unexpected server error." }, 500);
  }
});

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
