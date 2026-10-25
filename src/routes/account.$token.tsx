import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PublicFrame } from "@/components/public/site-frame";
import { getCustomerPortal } from "@/lib/office/api";
import type { PortalAccount } from "@/lib/office/customer-portal.server";
import { formatZar } from "@/lib/office/money";

export const Route = createFileRoute("/account/$token")({
  head: () => ({
    meta: [
      { title: "Your account · Vantage-ARS" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  loader: ({ params }) => getCustomerPortal({ data: { token: params.token } }),
  component: CustomerPortalPage,
});

function CustomerPortalPage() {
  const data = Route.useLoaderData() as
    | { ok: true; account: PortalAccount }
    | { ok: false; error: string };
  if (!data.ok) {
    return (
      <PublicFrame>
        <section className="mx-auto max-w-2xl py-20">
          <p className="text-sm text-accent">Account link</p>
          <h1 className="mt-3 font-serif text-4xl tracking-[-0.03em] sm:text-5xl">
            We can't open this account.
          </h1>
          <p className="mt-4 text-muted">{data.error}</p>
          <div className="mt-8">
            <Link to="/support" className="cta inline-flex h-11 items-center rounded-md px-5 text-sm font-semibold">
              Contact the service desk
            </Link>
          </div>
        </section>
      </PublicFrame>
    );
  }
  const account = data.account;
  return (
    <PublicFrame>
      <section className="mx-auto max-w-4xl py-12">
        <p className="text-sm text-accent">Your account</p>
        <h1 className="mt-3 font-serif text-4xl tracking-[-0.03em] sm:text-5xl">{account.companyName}</h1>
        <p className="mt-2 text-muted">Open balance: {formatZar(account.openBalanceCents)}</p>

        <div className="mt-8 space-y-8">
          <Block title="Invoices">
            {account.invoices.length === 0 ? <Empty /> : (
              <ul className="space-y-2">
                {account.invoices.map((inv: PortalAccount["invoices"][number]) => (
                  <li key={inv.id} className="flex justify-between border-b border-border py-2 text-sm">
                    <span>{inv.memo || inv.id}</span>
                    <span>{formatZar(inv.amountCents)} · {inv.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <Block title="Receipts">
            {account.receipts.length === 0 ? <Empty /> : (
              <ul className="space-y-2">
                {account.receipts.map((r: PortalAccount["receipts"][number]) => (
                  <li key={r.id} className="flex justify-between border-b border-border py-2 text-sm">
                    <span>{r.id}</span>
                    <span>{formatZar(r.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <Block title="Quotes">
            {account.quotes.length === 0 ? <Empty /> : (
              <ul className="space-y-2">
                {account.quotes.map((q: PortalAccount["quotes"][number]) => (
                  <li key={q.id} className="flex justify-between border-b border-border py-2 text-sm">
                    <span>{q.title}</span>
                    <span>{q.amountCents !== null ? formatZar(q.amountCents) : "—"} · {q.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <Block title="Subscriptions">
            {account.subscriptions.length === 0 ? <Empty /> : (
              <ul className="space-y-2">
                {account.subscriptions.map((s: PortalAccount["subscriptions"][number]) => (
                  <li key={s.id} className="flex justify-between border-b border-border py-2 text-sm">
                    <span>{s.planId}</span>
                    <span>{formatZar(s.priceCents)}/{s.cycle} · {s.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <Block title="Notices">
            {account.notices.length === 0 ? <Empty /> : (
              <ul className="space-y-2">
                {account.notices.map((n: PortalAccount["notices"][number]) => (
                  <li key={n.id} className="flex justify-between border-b border-border py-2 text-sm">
                    <span>{n.template}</span>
                    <span>{n.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Block>
        </div>
      </section>
    </PublicFrame>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="font-serif text-2xl">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-muted">Nothing on file yet.</p>;
}
