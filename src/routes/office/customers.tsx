import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/office/empty-state";
import { PageHeader } from "@/components/office/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { getCustomers, createCustomerPortalLink } from "@/lib/office/api";
import {
  customerAccountsToCsv,
  planLabel,
  type CustomerAccount,
  type CustomerBook,
  type CustomerStatus,
} from "@/lib/office/customers";
import { formatDate, formatRelative, formatZar } from "@/lib/office/format";

export const Route = createFileRoute("/office/customers")({
  component: CustomersPage,
});

type Filter = "all" | CustomerStatus;

const FILTER_LABELS: Record<Filter, string> = {
  all: "Every account",
  client: "Clients",
  prospect: "Prospects",
  lost: "Lost",
};

const STATUS_LABELS: Record<CustomerStatus, string> = {
  client: "Client",
  prospect: "Prospect",
  lost: "Lost",
};

function customersToDownload(accounts: CustomerAccount[]): void {
  const blob = new Blob([customerAccountsToCsv(accounts)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vantage-ars-customers-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function CustomersPage() {
  const [book, setBook] = useState<CustomerBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getCustomers();
      setBook(next);
      setError(null);
    } catch {
      setBook(null);
      setError("The customer book could not be read from this session.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getCustomers()
      .then((next) => {
        if (cancelled) return;
        setBook(next);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setBook(null);
        setError("The customer book could not be read from this session.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const accounts = useMemo(() => {
    const rows = book?.accounts ?? [];
    const needle = query.trim().toLowerCase();
    return rows.filter((account) => {
      if (filter !== "all" && account.status !== filter) return false;
      if (!needle) return true;
      return [account.companyName, account.contactName, account.contactEmail]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(needle));
    });
  }, [book, filter, query]);

  const summary = book?.summary ?? null;

  return (
    <div className="enter-up mx-auto max-w-6xl">
      <PageHeader
        kicker="Customers · accounts"
        title="Every conversation, one account."
        description="The customer book is assembled from the office's own enquiries, quotes, invoices, receipts and subscriptions. It reads records; it does not invent a relationship."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={!book || book.accounts.length === 0}
            onClick={() => book && customersToDownload(book.accounts)}
          >
            Export CSV
          </Button>
        }
      />

      {error ? (
        <p
          role="status"
          className="mb-6 rounded-xl bg-warn/15 px-4 py-3 text-sm text-warn shadow-[var(--shadow-border)]"
        >
          {error}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-3"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            {loading ? "Reading…" : "Try again"}
          </Button>
        </p>
      ) : null}

      {summary ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Figure label="Accounts" value={String(summary.accounts)} hint="companies on record" />
          <Figure
            label="Clients"
            value={String(summary.clients)}
            hint={`${summary.prospects} prospects`}
          />
          <Figure
            label="Monthly recurring"
            value={formatZar(summary.monthlyRecurringCents)}
            hint={`${summary.activeSubscriptions} active plans`}
          />
          <Figure
            label="Outstanding"
            value={formatZar(summary.outstandingCents)}
            hint={`${summary.churnRisk} need attention`}
            tone={summary.outstandingCents > 0 ? "warn" : undefined}
          />
          <Figure
            label="Overdue"
            value={formatZar(summary.overdueCents)}
            hint="issued for more than 7 days"
            tone={summary.overdueCents > 0 ? "danger" : undefined}
          />
        </div>
      ) : null}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label
            htmlFor="customer-search"
            className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted"
          >
            Search the book
          </label>
          <Input
            id="customer-search"
            className="mt-2"
            value={query}
            placeholder="Company, contact or email"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="sm:w-52">
          <label
            htmlFor="customer-filter"
            className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted"
          >
            Status
          </label>
          <Select
            id="customer-filter"
            className="mt-2"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            {(Object.keys(FILTER_LABELS) as Filter[]).map((value) => (
              <option key={value} value={value}>
                {FILTER_LABELS[value]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <p aria-live="polite" className="mb-3 text-xs text-muted">
        {loading
          ? "Reading the customer book…"
          : `${accounts.length} account${accounts.length === 1 ? "" : "s"} shown.`}
      </p>

      {!book && loading ? (
        <Card className="p-6">
          <p className="text-sm text-muted">Reading the customer book…</p>
        </Card>
      ) : accounts.length === 0 ? (
        <EmptyState
          title={book?.accounts.length ? "No match" : "The book is empty"}
          body={
            book?.accounts.length
              ? "No account matches that search and status. Clear the filters to see the whole book."
              : "No company has contacted the office yet. The book fills itself from real enquiries, invoices and subscriptions."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl bg-surface shadow-[var(--shadow-border)]">
          <table className="w-full min-w-[54rem] text-left text-sm">
            <caption className="sr-only">
              Customer accounts with status, recurring revenue, outstanding money and last activity.
              Every account can be expanded for its full record.
            </caption>
            <thead className="text-xs uppercase tracking-[0.14em] text-muted">
              <tr className="border-b border-border">
                <th scope="col" className="px-4 py-3 font-medium">
                  Account
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Recurring
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Outstanding
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Last activity
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const expanded = open === account.companyName;
                return (
                  <AccountRows
                    key={account.companyName}
                    account={account}
                    expanded={expanded}
                    onToggle={() =>
                      setOpen((current) =>
                        current === account.companyName ? null : account.companyName,
                      )
                    }
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AccountRows({
  account,
  expanded,
  onToggle,
}: {
  account: CustomerAccount;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border align-top">
        <td className="px-4 py-3">
          <p className="font-medium text-fg">{account.companyName}</p>
          <p className="mt-1 text-xs text-muted">
            {[account.contactName, account.contactEmail].filter(Boolean).join(" · ") ||
              "No contact on file"}
          </p>
          {account.churnRisk ? <p className="mt-1 text-xs text-warn">Needs attention</p> : null}
        </td>
        <td className="px-4 py-3">
          <Badge variant={statusVariant(account.status)}>{STATUS_LABELS[account.status]}</Badge>
        </td>
        <td className="px-4 py-3 text-right font-mono tabular-nums">
          {formatZar(account.monthlyRecurringCents)}
          <p className="text-xs text-muted">
            {account.activeSubscriptions} plan{account.activeSubscriptions === 1 ? "" : "s"}
          </p>
        </td>
        <td className="px-4 py-3 text-right font-mono tabular-nums">
          {formatZar(account.outstandingCents)}
          {account.overdueCents > 0 ? (
            <p className="text-xs text-danger">{formatZar(account.overdueCents)} overdue</p>
          ) : null}
        </td>
        <td className="px-4 py-3 text-muted">
          {account.lastActivityAt ? formatRelative(account.lastActivityAt) : "—"}
        </td>
        <td className="px-4 py-3 text-right">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? "Hide" : "Details"}
            <span className="sr-only"> for {account.companyName}</span>
          </Button>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border bg-raised/40">
          <td colSpan={6} className="px-4 py-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Invoiced" value={formatZar(account.invoicedCents)} />
              <Fact label="Received" value={formatZar(account.receivedCents)} />
              <Fact label="Pipeline" value={formatZar(account.pipelineCents)} />
              <Fact label="Won" value={formatZar(account.wonCents)} />
              <Fact label="Open opportunities" value={String(account.openOpportunities)} />
              <Fact label="Lead score" value={String(account.leadScore)} />
              <Fact
                label="Next billing"
                value={account.nextBillingAt ? formatDate(account.nextBillingAt) : "No active plan"}
              />
              <Fact
                label="First seen"
                value={account.firstSeenAt ? formatDate(account.firstSeenAt) : "Unknown"}
              />
            </div>
            <p className="mt-4 text-sm text-muted">
              <span className="font-medium text-fg">Plans:</span>{" "}
              {account.planIds.length > 0
                ? account.planIds.map(planLabel).join(", ")
                : "No active plan"}
            </p>
            <div className="mt-4 flex flex-wrap gap-3 text-xs">
              <button
                type="button"
                className="text-accent underline-offset-4 hover:underline"
                onClick={async () => {
                  try {
                    const res = await createCustomerPortalLink({ data: { companyName: account.companyName, days: 30 } });
                    const url = `${window.location.origin}/account/${res.token}`;
                    window.prompt("Customer portal link (copy):", url);
                  } catch {
                    window.alert("Could not create a portal link.");
                  }
                }}
              >
                Create portal link
              </button>
              <Link to="/office/sales" className="text-accent underline-offset-4 hover:underline">
                Open sales
              </Link>
              <Link to="/office/ledger" className="text-accent underline-offset-4 hover:underline">
                Open ledger
              </Link>
              <Link to="/office/revenue" className="text-accent underline-offset-4 hover:underline">
                Open recurring revenue
              </Link>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function statusVariant(status: CustomerStatus): "ok" | "warn" | "danger" {
  if (status === "client") return "ok";
  if (status === "lost") return "danger";
  return "warn";
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "warn" | "danger";
}) {
  const toneClass = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "";
  return (
    <Card className="p-4">
      <p className="text-[11px] uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className={`mt-2 font-mono text-2xl tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-1 text-xs text-subtle">{hint}</p>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-subtle">{label}</p>
      <p className="mt-1 font-mono text-sm tabular-nums text-fg">{value}</p>
    </div>
  );
}
