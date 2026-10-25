/**
 * Tokenized, read-only self-service links for customers.
 *
 * A founder generates a link for a company; the customer opens it and sees
 * their own invoices, receipts, quotes, subscriptions and notices. The link
 * expires and can be revoked. The office never exposes another company's data
 * through it, and the link carries no authority to change anything.
 */
import { randomBytes } from "node:crypto";
import { getSql } from "../db";

const TOKEN_BYTES = 24;

export async function ensurePortalTable(): Promise<void> {
  const sql = await getSql();
  await sql`
    create table if not exists customer_portal_links (
      id text primary key,
      token text not null unique,
      company_name text not null,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      last_viewed_at timestamptz,
      view_count integer not null default 0,
      revoked_at timestamptz
    )
  `;
  await sql`create index if not exists customer_portal_links_token_idx on customer_portal_links (token)`;
  await sql`create index if not exists customer_portal_links_company_idx on customer_portal_links (lower(company_name))`;
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export async function createPortalLink(input: {
  companyName: string;
  days?: number;
}): Promise<{ id: string; token: string; expiresAt: string }> {
  await ensurePortalTable();
  const sql = await getSql();
  const id = crypto.randomUUID();
  const token = newToken();
  const days = Math.max(1, Math.min(365, Math.trunc(input.days ?? 30)));
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  await sql`
    insert into customer_portal_links (id, token, company_name, expires_at)
    values (${id}, ${token}, ${input.companyName.trim()}, ${expiresAt})
  `;
  return { id, token, expiresAt };
}

export async function revokePortalLink(id: string): Promise<void> {
  await ensurePortalTable();
  const sql = await getSql();
  await sql`
    update customer_portal_links set revoked_at = now() where id = ${id} and revoked_at is null
  `;
}

export type PortalAccount = {
  companyName: string;
  invoices: { id: string; amountCents: number; status: string; createdAt: string; memo: string }[];
  receipts: { id: string; amountCents: number; createdAt: string }[];
  quotes: { id: string; title: string; status: string; amountCents: number | null; createdAt: string }[];
  subscriptions: { id: string; planId: string; cycle: string; priceCents: number; status: string; nextBillingAt: string }[];
  notices: { id: string; template: string; status: string; createdAt: string }[];
  openBalanceCents: number;
};

export async function readCustomerAccount(companyName: string): Promise<PortalAccount> {
  await ensurePortalTable();
  const sql = await getSql();
  const key = companyName.trim().toLowerCase();
  const invoices = await sql<{ id: string; amount_cents: number; status: string; created_at: string | Date; memo: string | null }>`
    select id, amount_cents, status, created_at, memo from ledger_entries
    where kind = 'invoice' and lower(counterparty) = ${key}
    order by created_at desc limit 200
  `;
  const receipts = await sql<{ id: string; amount_cents: number; created_at: string | Date }>`
    select id, amount_cents, created_at from ledger_entries
    where kind = 'receipt' and lower(counterparty) = ${key}
    order by created_at desc limit 200
  `;
  const quotes = await sql<{ id: string; title: string; status: string; amount_cents: number | null; created_at: string | Date }>`
    select d.id, d.title, d.status, d.amount_cents, d.created_at from documents d
    where d.kind = 'quote' and d.related_id in (select id from opportunities where lower(company_name) = ${key})
    order by d.created_at desc limit 200
  `;
  const subscriptions = await sql<{ id: string; plan_id: string; cycle: string; price_cents: number; status: string; next_billing_at: string | Date }>`
    select id, plan_id, cycle, price_cents, status, next_billing_at from subscriptions
    where lower(company_name) = ${key}
    order by next_billing_at asc limit 50
  `;
  const notices = await sql<{ id: string; template: string; status: string; created_at: string | Date }>`
    select id, template, status, created_at from customer_notices
    where lower(company_name) = ${key}
    order by created_at desc limit 100
  `;
  const openBalance = invoices.reduce((s, r) => s + Number(r.amount_cents ?? 0), 0)
    - receipts.reduce((s, r) => s + Number(r.amount_cents ?? 0), 0);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    companyName: companyName.trim(),
    invoices: invoices.map((r) => ({ id: String(r.id), amountCents: Number(r.amount_cents), status: String(r.status), createdAt: iso(r.created_at), memo: String(r.memo ?? "") })),
    receipts: receipts.map((r) => ({ id: String(r.id), amountCents: Number(r.amount_cents), createdAt: iso(r.created_at) })),
    quotes: quotes.map((r) => ({ id: String(r.id), title: String(r.title), status: String(r.status), amountCents: r.amount_cents === null ? null : Number(r.amount_cents), createdAt: iso(r.created_at) })),
    subscriptions: subscriptions.map((r) => ({ id: String(r.id), planId: String(r.plan_id), cycle: String(r.cycle), priceCents: Number(r.price_cents), status: String(r.status), nextBillingAt: iso(r.next_billing_at) })),
    notices: notices.map((r) => ({ id: String(r.id), template: String(r.template), status: String(r.status), createdAt: iso(r.created_at) })),
    openBalanceCents: openBalance,
  };
}

export async function resolvePortalLink(token: string): Promise<{ companyName: string } | null> {
  await ensurePortalTable();
  const sql = await getSql();
  const rows = await sql<{ company_name: string; expires_at: string | Date; revoked_at: string | null }>`
    select company_name, expires_at, revoked_at from customer_portal_links where token = ${token}
  `;
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at as string | Date).getTime() <= Date.now()) return null;
  // record view
  await sql`
    update customer_portal_links set view_count = view_count + 1, last_viewed_at = now() where token = ${token}
  `;
  return { companyName: String(row.company_name) };
}
