/**
 * External anchoring for the audit chain — the server half.
 *
 * Reads and writes `chain_anchors`, and optionally mirrors each anchor to a
 * file under `ANCHOR_DIR` (or a default location) so a copy of the head exists
 * outside the database. The office never reads the file back as authority: the
 * database row is the record, and the file is a witness.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getSql } from "../db";
import { COMPANY } from "./company";
import type { Anchor } from "./anchor";
import { verifyAnchors, anchorDue } from "./anchor";

function anchorDir(): string {
  const raw = process.env.ANCHOR_DIR?.trim();
  if (raw) return raw;
  return join(process.cwd(), ".anchors");
}

export async function ensureAnchorTable(): Promise<void> {
  const sql = await getSql();
  await sql`
    create table if not exists chain_anchors (
      id text primary key,
      head_hash text not null,
      anchored_at timestamptz not null default now(),
      anchor_kind text not null default 'internal',
      note text not null default '',
      verified_at timestamptz,
      verification_ok boolean,
      timestamp_token text,
      timestamp_authority text,
      timestamped_at timestamptz
    )
  `;
  await sql`alter table chain_anchors add column if not exists timestamp_token text`;
  await sql`alter table chain_anchors add column if not exists timestamp_authority text`;
  await sql`alter table chain_anchors add column if not exists timestamped_at timestamptz`;
  await sql`create index if not exists chain_anchors_anchored_idx on chain_anchors (anchored_at desc)`;
  await sql`create index if not exists chain_anchors_head_idx on chain_anchors (head_hash)`;
}

export async function listAnchors(limit = 50): Promise<Anchor[]> {
  await ensureAnchorTable();
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    head_hash: string;
    anchored_at: string | Date;
    anchor_kind: string;
    note: string;
  }>`
    select id, head_hash, anchored_at, anchor_kind, note
    from chain_anchors
    order by anchored_at desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: String(row.id),
    headHash: String(row.head_hash),
    anchoredAt:
      row.anchored_at instanceof Date ? row.anchored_at.toISOString() : String(row.anchored_at),
    kind: String(row.anchor_kind),
    note: String(row.note ?? ""),
  }));
}

export async function latestAnchor(): Promise<Anchor | null> {
  const rows = await listAnchors(1);
  return rows[0] ?? null;
}



/**
 * Request an RFC 3161 timestamp token for `headHash` from the configured
 * authority. Returns null when no authority is configured or the request
 * fails — anchoring still succeeds; the token is a witness, not a gate.
 */
export async function requestTimestampToken(headHash: string): Promise<{ token: string; authority: string } | null> {
  const authority = process.env.TIMESTAMP_AUTHORITY_URL?.trim();
  if (!authority) return null;
  try {
    const res = await fetch(authority, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: headHash,
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) return null;
    const token = Buffer.from(buf).toString("base64");
    return { token, authority };
  } catch {
    return null;
  }
}

export async function createAnchor(input: {
  headHash: string;
  kind?: string;
  note?: string;
}): Promise<Anchor> {
  await ensureAnchorTable();
  const sql = await getSql();
  const id = crypto.randomUUID();
  const kind = input.kind ?? "internal";
  const note = input.note ?? "";
  const ts = await requestTimestampToken(input.headHash);
  await sql`
    insert into chain_anchors (id, head_hash, anchor_kind, note, timestamp_token, timestamp_authority, timestamped_at)
    values (${id}, ${input.headHash}, ${kind}, ${note}, ${ts?.token ?? null}, ${ts?.authority ?? null},
            ${ts ? new Date().toISOString() : null})
  `;
  const anchor: Anchor = {
    id,
    headHash: input.headHash,
    anchoredAt: new Date().toISOString(),
    kind,
    note,
  };

  // Mirror to a file outside the database, best effort. A failure here does
  // not undo the anchor: the row is the record.
  try {
    const dir = anchorDir();
    mkdirSync(dir, { recursive: true });
    const line = `${anchor.anchoredAt}\t${anchor.headHash}\t${anchor.id}\n`;
    appendFileSync(join(dir, "anchors.log"), line, { encoding: "utf8" });
  } catch {
    // The file witness is optional; the row is authoritative.
  }

  return anchor;
}

export async function anchorIfDue(currentHead: string): Promise<Anchor | null> {
  const anchors = await listAnchors(20);
  if (!anchorDue(anchors, currentHead)) return null;
  return createAnchor({
    headHash: currentHead,
    kind: "scheduled",
    note: "Scheduled anchor of the audit-chain head.",
  });
}



/**
 * Anchors that carry an external timestamp token. The token is a witness the
 * office cannot forge; a full ASN.1 verification of the RFC 3161 response is
 * left to a dedicated verifier, but the presence of a token naming this head
 * is itself evidence that an external authority saw it.
 */
export async function timestampedAnchors(): Promise<Anchor[]> {
  await ensureAnchorTable();
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    head_hash: string;
    anchored_at: string | Date;
    anchor_kind: string;
    note: string;
    timestamp_token: string | null;
  }>`
    select id, head_hash, anchored_at, anchor_kind, note, timestamp_token
    from chain_anchors
    where timestamp_token is not null
    order by anchored_at desc
  `;
  return rows.map((row) => ({
    id: String(row.id),
    headHash: String(row.head_hash),
    anchoredAt: row.anchored_at instanceof Date ? row.anchored_at.toISOString() : String(row.anchored_at),
    kind: String(row.anchor_kind),
    note: String(row.note ?? ""),
  }));
}

export async function verifyAnchorsAgainstChain(currentHead: string): Promise<{
  ok: boolean;
  checked: number;
  brokenAt: string | null;
  detail: string;
}> {
  await ensureAnchorTable();
  const anchors = await listAnchors(200);
  const sql = await getSql();
  const rows = await sql<{ record_hash: string }>`
    select record_hash from (
      select record_hash from audit_events
      union
      select record_hash from decisions
    ) h
  `;
  const chainHashes = new Set(rows.map((r) => String(r.record_hash)));
  // The current head is always an honourable point even if it has not been
  // written as a row yet (genesis).
  if (currentHead) chainHashes.add(currentHead);
  const verdict = verifyAnchors(anchors, chainHashes, currentHead);

  // Record the verification result on every anchor row, best effort.
  try {
    const sql2 = await getSql();
    await sql2`
      update chain_anchors
      set verified_at = now(), verification_ok = ${verdict.ok}
      where id in (select id from chain_anchors)
    `;
  } catch {
    // Verification state is advisory; do not fail the read.
  }

  return verdict;
}

export { anchorDue };
