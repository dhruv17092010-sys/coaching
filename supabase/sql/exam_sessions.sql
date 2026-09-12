-- ============================================================
-- ChalkQuiz Board Exam Simulator — anti-cheating session tracking
-- ------------------------------------------------------------
-- Run this ONCE in Supabase Dashboard → SQL Editor → New query → Run.
--
-- Design goal: the warning count and cancellation decision must be
-- authoritative on the server, so a student who edits the site's
-- JavaScript (or blocks specific network calls) cannot rewrite their
-- own warning count. This table has Row Level Security enabled with
-- NO policies for the anon/authenticated roles, so the browser's
-- public API key cannot read or write it at all. Only Edge Functions
-- (using the service_role key, which is never sent to the browser)
-- can touch this table.
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists public.exam_sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  subject text not null,
  class_name text not null,
  board text not null,
  total_marks integer not null,
  status text not null default 'active' check (status in ('active', 'cancelled', 'completed')),
  warnings integer not null default 0,
  last_violation text
);

alter table public.exam_sessions enable row level security;
-- No policies are added on purpose: RLS with zero policies denies all
-- access to anon/authenticated roles by default. service_role bypasses
-- RLS entirely, which is how the Edge Functions reach this table.

-- Atomically increments the warning count and cancels the session on the
-- 2nd violation, in a single statement (no read-then-write race condition).
create or replace function public.report_violation(p_session_id uuid, p_violation_type text)
returns table(warnings integer, status text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.exam_sessions
  set
    warnings = exam_sessions.warnings + 1,
    last_violation = p_violation_type,
    status = case when exam_sessions.warnings + 1 >= 2 then 'cancelled' else exam_sessions.status end,
    updated_at = now()
  where exam_sessions.id = p_session_id
  returning exam_sessions.warnings, exam_sessions.status;
end;
$$;

-- Lock the function down to service_role only, matching the table's RLS.
revoke all on function public.report_violation(uuid, text) from public, anon, authenticated;
grant execute on function public.report_violation(uuid, text) to service_role;
