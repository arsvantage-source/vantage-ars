import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyAnchors, anchorDue, type Anchor } from "./anchor.ts";

const a = (id: string, head: string, at: string): Anchor => ({
  id,
  headHash: head,
  anchoredAt: at,
  kind: "scheduled",
  note: "",
});

describe("anchor verification", () => {
  it("an empty anchor set is trivially honoured", () => {
    const v = verifyAnchors([], new Set(), "head");
    assert.equal(v.ok, true);
    assert.equal(v.checked, 0);
  });

  it("an anchor whose head is still in the chain is honoured", () => {
    const v = verifyAnchors([a("1", "abc", "2026-01-01T00:00:00Z")], new Set(["abc"]), "xyz");
    assert.equal(v.ok, true);
  });

  it("the current head is honourable even before it is written as a row", () => {
    const v = verifyAnchors([a("1", "head", "2026-01-01T00:00:00Z")], new Set(), "head");
    assert.equal(v.ok, true);
  });

  it("an anchor whose head has vanished fails", () => {
    const v = verifyAnchors([a("1", "gone", "2026-01-01T00:00:00Z")], new Set(["abc"]), "xyz");
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, "1");
  });

  it("two anchors claiming the same head fail", () => {
    const v = verifyAnchors(
      [a("1", "h", "2026-01-01T00:00:00Z"), a("2", "h", "2026-01-02T00:00:00Z")],
      new Set(["h"]),
      "h",
    );
    assert.equal(v.ok, false);
  });
});

describe("anchor due", () => {
  it("is due when there are no anchors", () => {
    assert.equal(anchorDue([], "h"), true);
  });

  it("is due when the head has moved since the last anchor", () => {
    assert.equal(anchorDue([a("1", "old", "2026-01-01T00:00:00Z")], "new"), true);
  });

  it("is not due when the latest anchor already covers the head", () => {
    assert.equal(anchorDue([a("1", "h", "2026-01-01T00:00:00Z")], "h"), false);
  });
});
