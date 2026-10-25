import type { AuditRow, DecisionRow, LedgerRow } from "./types";

/**
 * One CSV cell.
 *
 * Quotes and line breaks are escaped. A leading formula character is prefixed
 * with an apostrophe so a customer name cannot become a spreadsheet formula
 * when the founder opens the export.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join(
    "\r\n",
  );
}

export function ledgerToCsv(rows: readonly LedgerRow[]): string {
  return toCsv(
    ["created_at", "kind", "counterparty", "status", "memo", "vat_zar", "amount_zar", "related_id"],
    rows.map((row) => [
      row.createdAt,
      row.kind,
      row.counterparty,
      row.status,
      row.memo,
      (row.vatCents / 100).toFixed(2),
      (row.amountCents / 100).toFixed(2),
      row.relatedId,
    ]),
  );
}

export function auditToCsv(rows: readonly AuditRow[]): string {
  return toCsv(
    ["created_at", "kind", "title", "actor", "body", "previous_hash", "record_hash"],
    rows.map((row) => [
      row.createdAt,
      row.kind,
      row.title,
      row.actor,
      row.body,
      row.previousHash,
      row.recordHash,
    ]),
  );
}

export function chainToCsv(audit: readonly AuditRow[], decisions: readonly DecisionRow[]): string {
  const rows = [
    ...audit.map((row) => ({
      createdAt: row.createdAt,
      source: "audit",
      kind: row.kind,
      title: row.title,
      actor: row.actor,
      body: row.body,
      previousHash: row.previousHash,
      recordHash: row.recordHash,
    })),
    ...decisions.map((row) => ({
      createdAt: row.createdAt,
      source: "decision",
      kind: row.actionKind,
      title: row.title,
      actor: row.agentId,
      body: row.rationale,
      previousHash: row.previousHash,
      recordHash: row.recordHash,
    })),
  ].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.recordHash.localeCompare(b.recordHash),
  );
  return toCsv(
    ["created_at", "source", "kind", "title", "actor", "body", "previous_hash", "record_hash"],
    rows.map((row) => [
      row.createdAt,
      row.source,
      row.kind,
      row.title,
      row.actor,
      row.body,
      row.previousHash,
      row.recordHash,
    ]),
  );
}


/**
 * Xero invoice-import CSV.
 *
 * One row per invoice ledger entry, in the shape Xero's "Import sales
 * invoices" wizard accepts. Amounts are in ZAR (the office's currency); VAT is
 * reported only where the invoice actually carried it. The office never states
 * VAT on a recurring invoice, so those rows read "Tax Exempt".
 */
export function xeroInvoicesToCsv(rows: readonly LedgerRow[]): string {
  const invoices = rows.filter((row) => row.kind === "invoice");
  return toCsv(
    [
      "ContactName",
      "InvoiceNumber",
      "InvoiceDate",
      "DueDate",
      "Description",
      "Quantity",
      "UnitAmount",
      "AccountCode",
      "TaxType",
      "Currency",
    ],
    invoices.map((row) => {
      const date = row.createdAt.slice(0, 10);
      const taxType = row.vatCents > 0 ? "15% (VAT on Income)" : "Tax Exempt";
      return [
        row.counterparty,
        row.relatedId ?? row.id ?? "",
        date,
        date,
        row.memo || row.kind,
        1,
        (row.amountCents / 100).toFixed(2),
        "200",
        taxType,
        "ZAR",
      ];
    }),
  );
}

/**
 * Sage 50 invoice-import CSV.
 *
 * A simpler, older shape for offices that run Sage: customer, invoice number,
 * date, net, VAT, gross.
 */
export function sageInvoicesToCsv(rows: readonly LedgerRow[]): string {
  const invoices = rows.filter((row) => row.kind === "invoice");
  return toCsv(
    ["Customer", "InvoiceNumber", "Date", "Net", "VAT", "Gross", "Reference"],
    invoices.map((row) => [
      row.counterparty,
      row.relatedId ?? row.id ?? "",
      row.createdAt.slice(0, 10),
      ((row.amountCents - row.vatCents) / 100).toFixed(2),
      (row.vatCents / 100).toFixed(2),
      (row.amountCents / 100).toFixed(2),
      row.memo || "",
    ]),
  );
}
