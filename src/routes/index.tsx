import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { PublicFrame } from "@/components/public/site-frame";
import { FormConfirmation } from "@/components/public/form-confirmation";
import { EnquiryForm } from "@/components/public/enquiry-form";
import {
  CloudIcon,
  InfraIcon,
  LiveNode,
  NetworkIcon,
  QuoteIcon,
  RestoreIcon,
  ShieldIcon,
  SignalBars,
  VoipIcon,
} from "@/components/public/motion-icons";
import { PathExhibit } from "@/components/public/live-field";
import { DecodeText } from "@/components/public/decode-text";
import { CountUp } from "@/components/public/count-up";
import { SignalPath } from "@/components/public/signal-path";
import { Reveal } from "@/components/public/reveal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { submitPaymentNotice, getPaymentMethods } from "@/lib/office/api";
import type { PaymentMethod } from "@/lib/office/invoice";
import { allMethodsAwaitBankDetails } from "@/lib/office/invoice";
import { SERVICE_PAGES } from "@/lib/site/services";
import { SERVICE_LINES, publicRateRows, rateAmount, ratesByIds } from "@/lib/office/catalogue";
import { businessJsonLd, faqJsonLd, pageHead, SITE_URL, jsonLd } from "@/lib/site/seo";
import { COMPANY } from "@/lib/office/company";

const LINE_ICONS = [
  VoipIcon,
  NetworkIcon,
  InfraIcon,
  SignalBars,
  CloudIcon,
  ShieldIcon,
  RestoreIcon,
] as const;

/** Every service line, paired with the page that explains it. */
const DEPARTMENTS = SERVICE_LINES.flatMap((line, index) => {
  const page = SERVICE_PAGES.find((item) => item.title === line.title);
  return page ? [{ line, page, Icon: LINE_ICONS[index] ?? VoipIcon }] : [];
});

const MANAGED_RATE_IDS = [
  "managed-support",
  "health-watch",
  "service-report",
  "billing-audit",
  "handover-pack",
  "continuity-plan",
  "sla-review",
  "quarterly-review",
  "fault-pattern-review",
];

const STEPS = [
  {
    n: "01",
    title: "Diagnose remotely first",
    body: "Endpoint and network symptoms, plus the call-path details you can provide.",
  },
  {
    n: "02",
    title: "Written quote",
    body: "Scope, hours, travel and VAT fixed in writing. Nothing starts until you accept.",
  },
  {
    n: "03",
    title: "Configure and test",
    body: "The agreed work is done and tested against the checks we set with you.",
  },
] as const;

const STATS = [
  {
    value: rateAmount("remote-support"),
    prefix: "R",
    suffix: " / hr",
    label: "Remote support, from",
  },
  {
    value: rateAmount("onsite-support"),
    prefix: "R",
    suffix: " / hr",
    label: "On-site, by arrangement",
  },
  { value: SERVICE_PAGES.length, label: "Departments on this desk" },
  { value: 0, label: "Contractual service levels sold" },
];

// One source of truth for the FAQ: rendered on the page (search engines only
// surface FAQ rich results for content that is visible to users) and emitted
// as FAQPage JSON-LD from Route.head below.
const FAQS = [
  {
    q: "How do I get a quote?",
    a: "Send the enquiry form. You get a written quote with scope and total before anyone starts.",
  },
  {
    q: "Do you charge VAT?",
    a: "VAT is added only when the written quote says so.",
  },
  {
    q: "Do you offer managed support?",
    a: "Yes. There is a monthly managed support plan at a fixed published price, remote only, with a written report every month. There is no live monitoring of your estate, no uptime promise and no contractual service level.",
  },
];

export const Route = createFileRoute("/")({
  head: () => {
    const head = pageHead({
      title: "VoIP, networking & IT infrastructure · Vantage-ARS",
      description:
        "Worldwide remote VoIP, networking and IT infrastructure support from Vantage-ARS, with clear ZAR pricing and a written quote before work starts.",
      path: "/",
      authorName: COMPANY.authorName,
    });

    return {
      ...head,
      scripts: [
        businessJsonLd(),
        faqJsonLd(FAQS),
        jsonLd({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "Vantage-ARS",
          url: SITE_URL,
        }),
      ],
    };
  },

  loader: () => getPaymentMethods(),

  component: HomePage,
});

function HomePage() {
  const payment = Route.useLoaderData();
  const rates = publicRateRows();
  const managedRates = ratesByIds(MANAGED_RATE_IDS);

  return (
    <PublicFrame>
      <section
        className="relative pb-16 pt-16 lg:pt-24"
        onMouseMove={(event) => {
          const el = event.currentTarget;
          const rect = el.getBoundingClientRect();

          el.style.setProperty("--mx", `${event.clientX - rect.left}px`);

          el.style.setProperty("--my", `${event.clientY - rect.top}px`);
        }}
      >
        <div
          aria-hidden
          className="spotlight pointer-events-none absolute inset-0 overflow-hidden"
        />

        <div className="grid items-start gap-12 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="relative">
            <p className="enter-up flex items-center gap-2.5 font-mono text-xs tracking-[0.22em] text-accent uppercase">
              <span className="live-dot size-1.5 rounded-full bg-ok" aria-hidden="true" />
              <DecodeText text="VoIP · Networking · IT infrastructure" />
            </p>

            <h1 className="enter-up d-1 mt-5 max-w-3xl text-5xl leading-[1.02] tracking-[-0.03em] sm:text-7xl">
              Clear scope.{" "}
              <span className="bg-gradient-to-r from-accent to-ok bg-clip-text text-transparent">
                Written quote.
              </span>{" "}
              No surprises.
            </h1>

            <p className="enter-up d-2 mt-6 max-w-2xl text-lg leading-relaxed text-muted">
              Worldwide remote support from R{rateAmount("remote-support")} an hour, on-site by
              arrangement from R{rateAmount("onsite-support")} an hour. You see the scope, timing
              and total in writing before anyone starts.
            </p>

            <div className="enter-up d-3 mt-8 flex flex-wrap gap-3">
              <Link
                to="/"
                hash="enquiry"
                className="cta inline-flex h-11 items-center rounded-md px-5 text-sm font-semibold"
              >
                Get a written quote
              </Link>

              <Link
                to="/rates"
                className="cta-ghost inline-flex h-11 items-center rounded-md px-5 text-sm font-semibold"
              >
                See published rates
              </Link>
            </div>
          </div>

          <div className="enter-up d-2 panel rounded-2xl">
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <p className="flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] text-fg uppercase">
                <LiveNode className="size-4" aria-hidden="true" />
                Departments
              </p>

              <p className="font-mono text-[11px] tracking-[0.16em] text-ok uppercase">Desk open</p>
            </div>

            <ul className="divide-y divide-border">
              {DEPARTMENTS.map(({ line, page, Icon }) => (
                <li key={line.number}>
                  <Link
                    to="/services/$slug"
                    params={{ slug: page.slug }}
                    className="group flex items-center gap-4 px-6 py-4 transition-colors hover:bg-raised/60"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-raised">
                      <Icon className="size-5 text-accent" aria-hidden="true" />
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-fg group-hover:text-accent">
                        {line.title}
                      </span>

                      <span className="mt-0.5 block text-sm text-muted">{line.price}</span>
                    </span>

                    <SignalBars className="size-4 shrink-0 text-ok" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>

            <div className="border-t border-border px-6 py-4">
              <Link
                to="/services/$slug"
                params={{ slug: "voip" }}
                className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.18em] text-accent uppercase hover:underline"
              >
                Open a department
                <QuoteIcon className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>

        <PathExhibit />
      </section>

      <section className="border-y border-border" aria-label="Desk facts">
        <dl className="grid divide-border sm:grid-cols-2 sm:divide-x lg:grid-cols-4">
          {STATS.map((stat, index) => (
            <Reveal
              key={stat.label}
              delay={index === 0 ? undefined : (index as 1 | 2 | 3)}
              // dt must precede dd in the DOM (a screen reader announces in
              // document order); flex-col-reverse keeps the number visually on
              // top without breaking that order.
              className="flex flex-col-reverse p-6 sm:p-8"
            >
              <dt className="mt-2 text-sm text-muted">{stat.label}</dt>
              <dd className="font-mono text-3xl font-semibold tabular-nums text-fg sm:text-4xl">
                <CountUp
                  value={stat.value}
                  prefix={"prefix" in stat ? stat.prefix : ""}
                  suffix={"suffix" in stat ? stat.suffix : ""}
                />
              </dd>
            </Reveal>
          ))}
        </dl>
      </section>

      <section className="border-b border-border py-16" aria-label="The practice">
        <h2 className="text-4xl sm:text-5xl">The work, as it sits.</h2>
        <p className="mt-4 max-w-2xl text-muted">
          Voice, the network under it, and the cabinet those calls depend on. Remote first. On-site
          only when the written quote includes it.
        </p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-3">
          {(
            [
              ["/images/handset.jpg", "A desk telephone", "VoIP"],
              ["/images/panel.jpg", "A network patch panel", "Networking"],
              ["/images/cabinet.jpg", "A server cabinet", "Infrastructure"],
            ] as const
          ).map(([src, alt, label]) => (
            <li key={src}>
              <figure className="overflow-hidden rounded-2xl border border-border">
                <img src={src} alt={alt} className="aspect-[3/2] w-full object-cover" />
                <figcaption className="border-t border-border px-4 py-3 font-mono text-[11px] tracking-[0.16em] text-subtle uppercase">
                  {label}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm text-muted">
          <Link to="/model" className="text-accent underline-offset-4 hover:underline">
            How the office runs
          </Link>
          , including what it does alone and what still waits.
        </p>
      </section>

      <section id="services" className="border-b border-border py-16" aria-label="Departments">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-4xl sm:text-5xl">Seven service lines, one desk</h2>

          <Link
            to="/services"
            className="font-mono text-xs tracking-[0.18em] text-subtle uppercase transition-colors hover:text-accent"
          >
            All seven lines →
          </Link>
        </div>

        <div className="mt-8 border-t border-border">
          {DEPARTMENTS.map(({ line, page, Icon }) => (
            <Link
              key={page.slug}
              to="/services/$slug"
              params={{ slug: page.slug }}
              className="group grid gap-3 border-b border-border px-2 py-6 transition-colors hover:bg-raised/50 sm:grid-cols-[3rem_1fr_10rem_2rem] sm:items-center sm:gap-6 sm:px-4"
            >
              <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-raised">
                <Icon className="size-6 text-accent" aria-hidden="true" />
              </span>

              <span>
                <span className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-subtle">{page.number}</span>

                  <span className="text-2xl group-hover:text-accent sm:text-3xl">{page.title}</span>
                </span>

                <span className="mt-2 block max-w-xl text-sm leading-relaxed text-muted">
                  {page.description}
                </span>
              </span>

              <span className="font-mono text-sm text-accent sm:text-right">{line.price}</span>

              <span
                aria-hidden
                className="hidden text-subtle transition-transform group-hover:translate-x-1 group-hover:text-accent sm:block"
              >
                &#8594;
              </span>
            </Link>
          ))}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-surface/50 p-5">
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            Not sure which line fits? Answer three questions and the service finder will name the
            closest published line, the guides that narrow it and what to put in the enquiry.
          </p>
          <Link
            to="/find"
            className="cta-ghost inline-flex h-10 items-center rounded-md px-4 text-sm font-medium"
          >
            Find your starting point
          </Link>
        </div>
      </section>

      <SignalPath />

      <section className="border-t border-border py-16" aria-label="How a job runs">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-4xl sm:text-5xl">How a job runs</h2>

          <p className="font-mono text-xs tracking-[0.18em] text-subtle uppercase">
            Same path every time
          </p>
        </div>

        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li
              key={step.n}
              className={`panel rounded-2xl p-6 ${
                index === 1 ? "enter-up d-1" : index === 2 ? "enter-up d-2" : "enter-up"
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="font-mono text-sm text-accent">{step.n}</p>

                <QuoteIcon className="size-5 text-subtle" aria-hidden="true" />
              </div>

              <h3 className="mt-4 text-2xl">{step.title}</h3>

              <p className="mt-2 text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="prices" className="border-t border-border py-16" aria-label="Prices">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 className="text-4xl sm:text-5xl">Published rates</h2>

          <p className="font-mono text-xs tracking-[0.18em] text-subtle uppercase">
            South African rand
          </p>
        </div>

        <p className="mt-3 max-w-xl text-base text-muted">
          VAT is added only when the written quote says so.{" "}
          <Link to="/rates" className="text-accent underline-offset-4 hover:underline">
            Full rate sheet
          </Link>
          .
        </p>

        <ul className="mt-8 border-t border-border">
          {rates.slice(0, 6).map((rate) => (
            <li
              key={rate.id}
              className="grid gap-2 border-b border-border py-5 transition-colors hover:bg-raised/40 sm:grid-cols-[1fr_10rem] sm:gap-8"
            >
              <div>
                <h3 className="text-base font-semibold text-fg">{rate.title}</h3>

                <p className="mt-1 text-sm text-muted">{rate.scope}</p>
              </div>

              <p className="font-mono text-sm font-medium text-accent sm:text-right">
                {rate.price}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section
        id="managed-services"
        className="border-t border-border py-16"
        aria-labelledby="managed-services-heading"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="managed-services-heading" className="text-4xl sm:text-5xl">
            Managed services
          </h2>

          <p className="font-mono text-xs tracking-[0.18em] text-subtle uppercase">
            Fixed scope, fixed price
          </p>
        </div>

        <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
          Not every job should need a ticket and a chase. The managed plan gives you remote support
          time each month, a written report on what we have actually done, and a quarterly look at
          the setup. Everything below is remote only and produced from our own records, so there is
          no live monitoring of your estate, no uptime promise and no contractual service level.
        </p>

        <ul className="mt-8 border-t border-border">
          {managedRates.map((rate) => (
            <li
              key={rate.id}
              className="grid gap-2 border-b border-border py-5 transition-colors hover:bg-raised/40 sm:grid-cols-[1fr_10rem] sm:gap-8"
            >
              <div>
                <h3 className="text-base font-semibold text-fg">{rate.title}</h3>

                <p className="mt-1 text-sm text-muted">{rate.scope}</p>
              </div>

              <p className="font-mono text-sm font-medium text-accent sm:text-right">
                {rate.price}
              </p>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            to="/services/$slug"
            params={{ slug: "managed-support" }}
            className="cta inline-flex h-11 items-center rounded-md px-5 text-sm font-semibold"
          >
            Managed services in detail
          </Link>

          <Link
            to="/rates"
            className="cta-ghost inline-flex h-11 items-center rounded-md px-5 text-sm font-semibold"
          >
            See published rates
          </Link>
        </div>
      </section>

      <section className="border-t border-border py-16" aria-label="Forms">
        <div className="grid gap-8 lg:grid-cols-2">
          <div id="enquiry" className="scroll-mt-24" aria-label="Enquiry">
            <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">01 · Enquiry</p>

            <h2 className="mt-4 text-4xl sm:text-5xl">Ask for a quote</h2>

            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
              A few sentences are enough. This is not a contract — you get a written quote first.
            </p>

            <div className="mt-8">
              <EnquiryForm
                nameMaxLength={120}
                messagePlaceholder="What stopped working, or what you want set up."
                submitLabel="Request a quote"
              />
            </div>
          </div>

          <div id="payment" className="scroll-mt-24" aria-label="Payment">
            <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">
              02 · Payment notice
            </p>

            <h2 className="mt-4 text-4xl sm:text-5xl">Paid already? Tell us.</h2>

            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
              Send the reference from your quote or invoice. This records your notice — it is not an
              automatic receipt.
            </p>

            <div className="mt-8">
              <PaymentForm payment={payment} />
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-border py-16" aria-label="Common questions">
        <h2 className="text-4xl sm:text-5xl">Common questions</h2>

        <dl className="mt-8 max-w-3xl divide-y divide-border border-y border-border">
          {FAQS.map((faq) => (
            <div key={faq.q} className="py-6">
              <dt className="font-serif text-2xl">{faq.q}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-muted">{faq.a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </PublicFrame>
  );
}

function PaymentForm({ payment }: { payment: unknown }) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    email: "",
    reference: "",
    amount: "",
    website: "",
  });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const result = await submitPaymentNotice({
        data: form,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setDone(true);
    } catch {
      setError("The notice could not be recorded. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <FormConfirmation>
        <p className="text-3xl text-ok">Noted.</p>

        <p className="mt-3 text-sm text-muted">
          Your payment notice is recorded. A receipt follows after it is checked.
        </p>
      </FormConfirmation>
    );
  }

  const methods = Array.isArray(payment) ? (payment as PaymentMethod[]) : [];

  return (
    <form onSubmit={onSubmit} className="glass space-y-4 rounded-2xl p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="pay-name">Name on payment</Label>

          <Input
            id="pay-name"
            className="mt-2"
            required
            value={form.name}
            onChange={(event) =>
              setForm({
                ...form,
                name: event.target.value,
              })
            }
          />
        </div>

        <div>
          <Label htmlFor="pay-email">Email</Label>

          <Input
            id="pay-email"
            type="email"
            className="mt-2"
            required
            value={form.email}
            onChange={(event) =>
              setForm({
                ...form,
                email: event.target.value,
              })
            }
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="pay-ref">Reference (VA-…)</Label>

          <Input
            id="pay-ref"
            className="mt-2"
            required
            placeholder="VA-XXXX"
            value={form.reference}
            onChange={(event) =>
              setForm({
                ...form,
                reference: event.target.value,
              })
            }
          />
        </div>

        <div>
          <Label htmlFor="pay-amount">Amount (R)</Label>

          <Input
            id="pay-amount"
            className="mt-2"
            required
            inputMode="decimal"
            pattern="[0-9]+([.,][0-9]+)?"
            title="Enter the amount in rand, for example 690.00"
            placeholder="690.00"
            value={form.amount}
            onChange={(event) =>
              setForm({
                ...form,
                amount: event.target.value,
              })
            }
          />
        </div>
      </div>

      <div className="h-0 overflow-hidden" aria-hidden="true">
        Leave this field empty
        <input
          tabIndex={-1}
          autoComplete="off"
          value={form.website}
          onChange={(event) =>
            setForm({
              ...form,
              website: event.target.value,
            })
          }
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {allMethodsAwaitBankDetails(methods) ? (
        <p className="text-xs text-subtle">Bank details are sent with your quote or invoice.</p>
      ) : null}

      <Button type="submit" disabled={pending} className="cta w-full border-0 sm:w-auto">
        {pending ? "Sending…" : "Notify payment"}
      </Button>
    </form>
  );
}
