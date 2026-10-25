import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useOfficeSnapshot } from "@/components/office/office-snapshot-hook";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { DispatchPanel } from "@/components/office/dispatch-panel";
import { EmptyState } from "@/components/office/empty-state";
import { PageHeader } from "@/components/office/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { filePaymentClaim, raiseInvoice, recordReceipt, savePaymentNote } from "@/lib/office/api";
import {
  VAT_TREATMENT_LABELS,
  parseVatTreatment,
  quoteInvoice,
  withPaymentNote,
  type VatTreatment,
} from "@/lib/office/invoice";
import { Select } from "@/components/ui/select";
import { formatDateTime, formatZar } from "@/lib/office/money";
import { ledgerToCsv, sageInvoicesToCsv, xeroInvoicesToCsv } from "@/lib/office/csv";

export const Route = createFileRoute("/office/ledger")({
  component: LedgerPage,
});

function LedgerPage() {
  const snapshot = useOfficeSnapshot();
  const { company } = snapshot;

  return (
    <div className="enter-up mx-auto max-w-5xl">
      <PageHeader
        kicker="Finance · LEDGER"
        title="Cash is zero until something clears."
        description="Invoices raise receivables. Receipts raise treasury. Choose the VAT treatment when you raise an invoice; none is added by default. Any expense is a founder approval."
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Treasury</p>
          <p className="mt-2 font-mono text-2xl tabular-nums">{formatZar(company.treasuryCents)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Receivable</p>
          <p className="mt-2 font-mono text-2xl tabular-nums">
            {formatZar(company.receivableCents)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Payable</p>
          <p className="mt-2 font-mono text-2xl tabular-nums">{formatZar(company.payableCents)}</p>
        </Card>
      </div>

      <PaymentNote current={company.paymentInstructions} />

      <PaymentNotices
        notices={snapshot.inbound.filter(
          (item) => item.intent === "payment_notice" && item.status !== "filed",
        )}
      />

      <ReadyInvoices
        opportunities={snapshot.opportunities.filter(
          (item) => item.stage === "won" && item.valueCents > 0,
        )}
        invoicedIds={snapshot.ledger
          .filter((row) => row.kind === "invoice" && row.relatedId)
          .map((row) => row.relatedId as string)}
      />

      <AwaitingPayment
        invoices={snapshot.ledger.filter(
          (row) => row.kind === "invoice" && row.status === "issued",
        )}
        documents={snapshot.documents.filter((item) => item.kind === "invoice")}
        paymentNote={company.paymentInstructions}
      />

      <div className="mt-6">
        <DispatchPanel
          lockedAgent="ledger"
          placeholder="Issue an invoice for a won opportunity, or record a receipt that actually arrived. Expenses must escalate."
        />
      </div>

      <PaidReceipts
        documents={snapshot.documents.filter((item) => item.kind === "receipt")}
        paymentNote={company.paymentInstructions}
      />

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-serif text-2xl">Journal</h2>
          {snapshot.ledger.length > 0 ? (
            <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadCsv("vantage-ledger.csv", ledgerToCsv(snapshot.ledger))}
            >
              Export journal CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadCsv("vantage-xero.csv", xeroInvoicesToCsv(snapshot.ledger))}
            >
              Export Xero CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadCsv("vantage-sage.csv", sageInvoicesToCsv(snapshot.ledger))}
            >
              Export Sage CSV
            </Button>
            </>
          ) : null}
        </div>
        {snapshot.ledger.length === 0 ? (
          <EmptyState
            title="No entries"
            body="The books are open and empty — correct for a company that has not yet taken a rand."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl bg-surface shadow-[var(--shadow-border)]">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.14em] text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Kind</th>
                  <th className="px-4 py-3 font-medium">Counterparty</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">VAT</th>
                  <th className="px-4 py-3 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.ledger.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-muted">{formatDateTime(row.createdAt)}</td>
                    <td className="px-4 py-3">{row.kind}</td>
                    <td className="px-4 py-3">{row.counterparty}</td>
                    <td className="px-4 py-3">
                      <Badge>{row.status}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatZar(row.vatCents)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {formatZar(row.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ReadyInvoices({
  opportunities,
  invoicedIds,
}: {
  opportunities: { id: string; companyName: string; valueCents: number }[];
  invoicedIds: string[];
}) {
  const ready = opportunities.filter((item) => !invoicedIds.includes(item.id));
  if (ready.length === 0) return null;
  return (
    <div className="mt-6 space-y-3">
      <h2 className="font-serif text-2xl">Ready to invoice</h2>
      <p className="text-sm text-muted">
        The figure is the accepted quote. VAT is not added. The customer is not emailed.
      </p>
      {ready.map((item) => (
        <InvoiceCard key={item.id} opportunity={item} />
      ))}
    </div>
  );
}

function InvoiceCard({
  opportunity,
}: {
  opportunity: { id: string; companyName: string; valueCents: number };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [treatment, setTreatment] = useState<VatTreatment>("none");
  const figure = quoteInvoice(opportunity.valueCents, treatment);

  async function onClick() {
    setPending(true);
    try {
      const result = await raiseInvoice({
        data: { opportunityId: opportunity.id, vatTreatment: treatment },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Invoice raised. Treasury does not move until a receipt is recorded.");
      await router.invalidate();
    } catch {
      toast.error("The invoice could not be raised.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm">{opportunity.companyName}</p>
        <p className="mt-1 font-mono text-2xl tabular-nums">
          {formatZar(figure.ok ? figure.cents : opportunity.valueCents)}
        </p>
        {figure.ok && treatment !== "none" ? (
          <p className="mt-1 text-xs text-muted">
            Excl. VAT {formatZar(figure.netCents)} · VAT {formatZar(figure.vatCents)}
          </p>
        ) : null}
      </div>
      <div className="w-full sm:w-64">
        <Label htmlFor={`vat-${opportunity.id}`}>VAT treatment</Label>
        <Select
          id={`vat-${opportunity.id}`}
          value={treatment}
          onChange={(event) => setTreatment(parseVatTreatment(event.target.value))}
        >
          {(Object.keys(VAT_TREATMENT_LABELS) as VatTreatment[]).map((key) => (
            <option key={key} value={key}>
              {VAT_TREATMENT_LABELS[key]}
            </option>
          ))}
        </Select>
      </div>
      <Button type="button" disabled={pending} onClick={() => void onClick()}>
        {pending ? "Raising…" : "Raise invoice"}
      </Button>
    </Card>
  );
}

function AwaitingPayment({
  invoices,
  documents,
  paymentNote,
}: {
  invoices: { id: string; counterparty: string; amountCents: number; relatedId: string | null }[];
  documents: { summary: string; relatedId: string | null }[];
  paymentNote: string;
}) {
  if (invoices.length === 0) return null;
  return (
    <div className="mt-6 space-y-3">
      <h2 className="font-serif text-2xl">Awaiting payment</h2>
      <p className="text-sm text-muted">
        Copy the invoice and send it yourself. A PDF uses the same figure. Record a payment only
        after the money has arrived.
      </p>
      {invoices.map((invoice) => {
        const summary = documents.find(
          (item) => item.relatedId && item.relatedId === invoice.relatedId,
        )?.summary;
        return (
          <ReceiptCard
            key={invoice.id}
            invoice={invoice}
            summary={summary}
            paymentNote={paymentNote}
          />
        );
      })}
    </div>
  );
}

function ReceiptCard({
  invoice,
  summary,
  paymentNote,
}: {
  invoice: { id: string; counterparty: string; amountCents: number };
  summary?: string;
  paymentNote: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const text = summary ? withPaymentNote(summary, paymentNote) : undefined;

  async function onClick() {
    setPending(true);
    try {
      const result = await recordReceipt({ data: { invoiceId: invoice.id } });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Receipt recorded. Treasury now includes this payment.");
      await router.invalidate();
    } catch {
      toast.error("The receipt could not be recorded.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm">{invoice.counterparty}</p>
          <p className="mt-1 font-mono text-2xl tabular-nums">{formatZar(invoice.amountCents)}</p>
        </div>
        <Badge variant="warn">Not emailed</Badge>
      </div>
      {text ? <p className="text-sm text-muted">{text}</p> : null}
      <div className="flex flex-wrap gap-2">
        {text ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(
                () => toast.success("Copied. Send it yourself. It has not been emailed."),
                () => toast.error("Could not copy. Select the invoice text instead."),
              );
            }}
          >
            Copy invoice
          </Button>
        ) : null}
        {summary ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void (async () => {
                const { buildQuotePdf, downloadPdf, quotePdfName } =
                  await import("@/lib/office/quote-pdf");
                const bytes = await buildQuotePdf({
                  kind: "invoice",
                  companyName: invoice.counterparty,
                  amount: formatZar(invoice.amountCents),
                  body: summary,
                  payment: paymentNote,
                });
                downloadPdf(bytes, quotePdfName(invoice.counterparty, summary, "invoice"));
                toast.success("PDF saved. Send it yourself. It has not been emailed.");
              })().catch(() => toast.error("The PDF could not be created."));
            }}
          >
            Download PDF
          </Button>
        ) : null}
        <Button type="button" disabled={pending} onClick={() => void onClick()}>
          {pending ? "Recording…" : "Payment received"}
        </Button>
      </div>
    </Card>
  );
}

function PaidReceipts({
  documents,
  paymentNote,
}: {
  documents: { id: string; title: string; summary: string }[];
  paymentNote: string;
}) {
  if (documents.length === 0) return null;
  return (
    <div className="mt-6 space-y-3">
      <h2 className="font-serif text-2xl">Receipts</h2>
      <p className="text-sm text-muted">
        Copy one if you want to send it. Nothing here is emailed.
      </p>
      {documents.map((document) => {
        const text = withPaymentNote(document.summary, paymentNote);
        return (
          <Card key={document.id}>
            <p className="text-sm">{document.title}</p>
            <p className="mt-3 text-sm text-muted">{text}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(text).then(
                    () => toast.success("Copied. Send it yourself. It has not been emailed."),
                    () => toast.error("Could not copy. Select the receipt text instead."),
                  );
                }}
              >
                Copy receipt
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  void (async () => {
                    const { buildQuotePdf, downloadPdf, quotePdfName } =
                      await import("@/lib/office/quote-pdf");
                    const company = document.title.replace(/^Receipt ·\s*/, "") || "Customer";
                    const amount = document.summary.match(/Amount received ([^.]+)/)?.[1] ?? "-";
                    const bytes = await buildQuotePdf({
                      kind: "receipt",
                      companyName: company,
                      amount,
                      body: document.summary,
                      payment: paymentNote,
                    });
                    downloadPdf(bytes, quotePdfName(company, document.summary, "receipt"));
                    toast.success("PDF saved. Send it yourself. It has not been emailed.");
                  })().catch(() => toast.error("The PDF could not be created."));
                }}
              >
                Download PDF
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function PaymentNotices({
  notices,
}: {
  notices: { id: string; companyName: string; summary: string }[];
}) {
  if (notices.length === 0) return null;
  return (
    <div className="mt-6 space-y-3">
      <h2 className="font-serif text-2xl">Customer says they paid</h2>
      <p className="text-sm text-muted">
        These are claims, not receipts. Treasury does not move until you record the payment on the
        invoice.
      </p>
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} />
      ))}
    </div>
  );
}

function NoticeCard({ notice }: { notice: { id: string; companyName: string; summary: string } }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onClick() {
    setPending(true);
    try {
      const result = await filePaymentClaim({ data: { inboundId: notice.id } });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Notice filed. Treasury was not changed.");
      await router.invalidate();
    } catch {
      toast.error("The notice could not be filed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <p className="text-sm">{notice.companyName}</p>
      <p className="mt-2 text-sm text-muted">{notice.summary}</p>
      <Button
        type="button"
        className="mt-4"
        variant="secondary"
        disabled={pending}
        onClick={() => void onClick()}
      >
        {pending ? "Filing…" : "File notice"}
      </Button>
    </Card>
  );
}

function PaymentNote({ current }: { current: string }) {
  const router = useRouter();
  const [text, setText] = useState(current);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      const result = await savePaymentNote({ data: { text } });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(text.trim() ? "Saved. It will appear on the next copy." : "Cleared.");
      await router.invalidate();
    } catch {
      toast.error("The payment note could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="mt-6">
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-3">
        <div>
          <Label htmlFor="pay-note">How customers pay</Label>
          <p className="mt-1 text-sm text-muted">
            Bank, reference, or other instructions. Leave this blank and the invoice will not invent
            them.
          </p>
        </div>
        <Textarea
          id="pay-note"
          value={text}
          maxLength={400}
          onChange={(event) => setText(event.target.value)}
          placeholder="Nothing saved yet"
        />
        <Button
          type="submit"
          variant="secondary"
          disabled={pending || text.trim() === current.trim()}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>
    </Card>
  );
}

function downloadCsv(filename: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
