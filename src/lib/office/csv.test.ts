import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditToCsv, chainToCsv, csvCell, ledgerToCsv, sageInvoicesToCsv, toCsv, xeroInvoicesToCsv } from "./csv.ts";
import type { AuditRow, DecisionRow, LedgerRow } from "./types.ts";

describe("csv exports", () => {
  it("escapes quotes, commas and newlines", () => {
    assert.equal(csvCell("a,b"), '"a,b"');
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell("a\nb"), '"a\nb"');
    assert.equal(csvCell(null), "");
  });

  it("neutralises a leading spreadsheet formula", () => {
    assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
    assert.equal(csvCell("+27 82 000 0000"), "'+27 82 000 0000");
    assert.equal(csvCell("@evil"), "'@evil");
  });

  it("writes a header and rows with CRLF", () => {
    assert.equal(
      toCsv(
        ["a", "b"],
        [
          [1, "x"],
          [2, null],
        ],
      ),
      "a,b\r\n1,x\r\n2,",
    );
  });

  it("exports the ledger without losing cents", () => {
    const row = {
      createdAt: "2026-04-01T10:00:00.000Z",
      kind: "invoice",
      counterparty: "Acme, Ltd",
      status: "issued",
      memo: "Managed support",
      vatCents: 1035,
      amountCents: 7935,
      relatedId: null,
    } as LedgerRow;
    const csv = ledgerToCsv([row]);
    assert.match(csv, /^created_at,kind/);
    assert.match(csv, /Acme, Ltd/);
    assert.match(csv, /79\.35/);
    assert.match(csv, /10\.35/);
  });

  it("exports the audit and decision records as one chain", () => {
    const audit = {
      createdAt: "2026-04-01T10:00:00.000Z",
      kind: "test",
      title: "Audit",
      actor: "founder",
      body: "An audit row",
      previousHash: "p",
      recordHash: "r1",
    } as AuditRow;
    const decision = {
      createdAt: "2026-04-01T11:00:00.000Z",
      actionKind: "issue_quote",
      title: "Decision",
      agentId: "sales",
      rationale: "A decision row",
      previousHash: "r1",
      recordHash: "r2",
    } as DecisionRow;
    const csv = chainToCsv([audit], [decision]);
    assert.match(csv, /source,kind/);
    assert.match(csv, /audit,test/);
    assert.match(csv, /decision,issue_quote/);
    assert.ok(csv.indexOf("audit,test") < csv.indexOf("decision,issue_quote"));
  });

  it("exports the audit chain with both hashes", () => {
    const row = {
      createdAt: "2026-04-01T10:00:00.000Z",
      kind: "test",
      title: "Test",
      actor: "founder",
      body: "A body",
      previousHash: "prev",
      recordHash: "next",
    } as AuditRow;
    const csv = auditToCsv([row]);
    assert.match(csv, /previous_hash,record_hash/);
    assert.match(csv, /prev,next/);
  });
});


  it("exports invoices in Xero import shape", () => {
    const row = {
      createdAt: "2026-04-01T10:00:00.000Z",
      kind: "invoice",
      counterparty: "Acme, Ltd",
      status: "issued",
      memo: "Managed support",
      vatCents: 0,
      amountCents: 7935,
      relatedId: "INV-1",
    } as LedgerRow;
    const csv = xeroInvoicesToCsv([row, { ...row, kind: "receipt" } as LedgerRow]);
    assert.match(csv, /^ContactName,InvoiceNumber/);
    assert.match(csv, /Acme, Ltd/);
    assert.match(csv, /Tax Exempt/);
    assert.match(csv, /79\.35/);
    // receipts are not invoices
    assert.equal(csv.split("\r\n").length, 2);
  });

  it("exports invoices in Sage import shape", () => {
    const row = {
      createdAt: "2026-04-01T10:00:00.000Z",
      kind: "invoice",
      counterparty: "Acme, Ltd",
      status: "issued",
      memo: "Managed support",
      vatCents: 1035,
      amountCents: 7935,
      relatedId: "INV-2",
    } as LedgerRow;
    const csv = sageInvoicesToCsv([row]);
    assert.match(csv, /^Customer,InvoiceNumber/);
    assert.match(csv, /69\.00/); // net
    assert.match(csv, /10\.35/); // vat
    assert.match(csv, /79\.35/); // gross
  });
