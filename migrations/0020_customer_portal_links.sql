-- 0020_customer_portal_links.sql
--
-- Tokenized, read-only self-service links for customers.
--
-- A founder generates a link for a company; the customer opens it and sees
-- their own invoices, receipts, quotes, subscriptions and notices, with no
-- login and no office access. The link expires and can be revoked. The office
-- never exposes another company's data through it.
--
-- Idempotent: safe to re-apply.

create table if not exists customer_portal_links (
  id text primary key,
  token text not null unique,
  company_name text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_viewed_at timestamptz,
  view_count integer not null default 0,
  revoked_at timestamptz
);

create index if not exists customer_portal_links_token_idx on customer_portal_links (token);
create index if not exists customer_portal_links_company_idx on customer_portal_links (lower(company_name));
