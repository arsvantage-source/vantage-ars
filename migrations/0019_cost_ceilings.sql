-- 0019_cost_ceilings.sql
--
-- Founder-controlled cost ceilings for the model budget.
--
-- The four levels (capsule, fire, daily, monthly) used to be constants in
-- code, which meant the office's own code could raise them. They now live in
-- a table that only the founder writes; the office reads them at admission
-- time and can never change them. A missing row falls back to the documented
-- default, so a fresh office keeps its original envelope until the founder
-- chooses otherwise.
--
-- Idempotent: safe to re-apply.

create table if not exists cost_ceilings (
  level text primary key,
  ceiling_cents integer not null,
  updated_at timestamptz not null default now(),
  updated_by text not null default 'founder'
);
