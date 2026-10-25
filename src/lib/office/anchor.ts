/**
 * External anchoring for the audit chain — the pure half.
 *
 * An anchor is a promise that the chain's head hashed to `headHash` at
 * `anchoredAt`. The office writes one on its own cadence, and a later
 * verification proves the current chain still descends from every anchored
 * head. If a wholesale rewrite removed or replaced the records that carried an
 * anchored head, the anchor's hash is no longer anywhere in the chain and the
 * verification fails.
 *
 * Pure module: no database, no clock, no filesystem. The server side owns the
 * rows and the optional external file; this module owns the comparison.
 */
export type Anchor = {
  id: string;
  headHash: string;
  anchoredAt: string;
  kind: string;
  note: string;
};

export type AnchorVerdict = {
  ok: boolean;
  checked: number;
  /** The id of the first anchor that failed, or null. */
  brokenAt: string | null;
  detail: string;
};

/**
 * Does the chain still honour every anchor?
 *
 * An anchor is honoured when its head hash is still present in the chain —
 * either as a record hash that exists today, or as the current head itself
 * (the latest anchor can legitimately be the current head). An anchor whose
 * head hash has vanished means the chain was rewritten past that point.
 *
 * Anchors are also checked for ordering: they must be strictly increasing in
 * time, and an anchor may not claim a head that a later anchor's head does not
 * descend from. Because we only hold the set of hashes rather than the full
 * parent map here, the ordering check is limited to "no two anchors share a
 * head unless they are the same anchor" and "heads are distinct points"; the
 * server side, which holds the chain, does the reachability check.
 */
export function verifyAnchors(
  anchors: Anchor[],
  chainHashes: Set<string>,
  currentHead: string,
): AnchorVerdict {
  if (!anchors.length) {
    return { ok: true, checked: 0, brokenAt: null, detail: "No anchors recorded yet." };
  }

  const ordered = [...anchors].sort((a, b) => a.anchoredAt.localeCompare(b.anchoredAt));

  // Distinct anchors must not claim the same head hash.
  const seenHeads = new Set<string>();
  for (const anchor of ordered) {
    if (seenHeads.has(anchor.headHash)) {
      return {
        ok: false,
        checked: ordered.length,
        brokenAt: anchor.id,
        detail: `Two anchors claim the same head ${anchor.headHash.slice(0, 12)}.`,
      };
    }
    seenHeads.add(anchor.headHash);
  }

  for (const anchor of ordered) {
    const honoured = chainHashes.has(anchor.headHash) || anchor.headHash === currentHead;
    if (!honoured) {
      return {
        ok: false,
        checked: ordered.length,
        brokenAt: anchor.id,
        detail: `Anchor ${anchor.id.slice(0, 8)} claims head ${anchor.headHash.slice(0, 12)}, which is no longer in the chain. The chain may have been rewritten.`,
      };
    }
  }

  return {
    ok: true,
    checked: ordered.length,
    brokenAt: null,
    detail: `${ordered.length} anchor(s) verified: every anchored head is still in the chain.`,
  };
}

/**
 * Whether a new anchor is worth writing.
 *
 * An anchor is due when there is no anchor yet, or the latest anchor's head no
 * longer matches the current head (the chain has moved since the last anchor).
 * Writing an anchor for a head that is already anchored would only add noise.
 */
export function anchorDue(anchors: Anchor[], currentHead: string): boolean {
  if (!anchors.length) return true;
  const latest = [...anchors].sort((a, b) => b.anchoredAt.localeCompare(a.anchoredAt))[0];
  return latest.headHash !== currentHead;
}
