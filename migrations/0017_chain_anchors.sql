-- 0017_chain_anchors.sql
--
-- External anchoring for the audit chain.
--
-- The chain is internally verifiable, but nothing outside the database holds a
-- copy of the head, so a wholesale rewrite of the chain could not be detected
-- from outside (see docs/governance-architecture.md, "deliberately not
-- implemented"). This table is the anchor store: an append-only log of chain
-- head hashes, written on the office's own cadence. Each row is a promise that
-- the chain contained that head at that instant, and a later verification can
-- prove the chain still descends from it. A row is never updated or deleted.
--
-- Idempotent: safe to re-apply.

create table if not exists chain_anchors (
  id text primary key,
  head_hash text not null,
  anchored_at timestamptz not null default now(),
  anchor_kind text not null default 'internal',
  note text not null default '',
  verified_at timestamptz,
  verification_ok boolean
);

create index if not exists chain_anchors_anchored_idx on chain_anchors (anchored_at desc);
create index if not exists chain_anchors_head_idx on chain_anchors (head_hash);
