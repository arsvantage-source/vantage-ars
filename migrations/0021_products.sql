-- 0021_products.sql
--
-- A general product catalogue. The office sells whatever is in this table,
-- priced by the founder, not by a hardcoded list. Anything the founder adds
-- here becomes quotable, invoiceable and (if recurring) subscribable.
--
-- Seeding from the legacy hardcoded catalogue happens in products.server.ts,
-- so the original rate card survives the migration and the office keeps
-- selling what it sold before. New products are added from the office.
--
-- Idempotent: safe to re-apply.

create table if not exists products (
  id text primary key,
  title text not null,
  scope text not null default '',
  price text not null default '',
  basis text not null default '',
  offered boolean not null default true,
  category text not null default 'general',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_offered_idx on products (offered, category);
