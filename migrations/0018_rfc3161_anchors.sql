-- 0018_rfc3161_anchors.sql
--
-- RFC 3161 timestamp tokens for anchored chain heads.
--
-- An anchor row already pins the head hash inside the database. A timestamp
-- token from an external authority pins the same hash to a time the office
-- cannot move, so a later rewrite cannot backdate the chain. The token is
-- stored verbatim; verification re-reads it and confirms it is present and
-- names the same head.
--
-- Idempotent: safe to re-apply.

alter table chain_anchors add column if not exists timestamp_token text;
alter table chain_anchors add column if not exists timestamp_authority text;
alter table chain_anchors add column if not exists timestamped_at timestamptz;
