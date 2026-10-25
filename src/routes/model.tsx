import { createFileRoute, Link } from "@tanstack/react-router";
import { PublicFrame } from "@/components/public/site-frame";
import { pageHead } from "@/lib/site/seo";

export const Route = createFileRoute("/model")({
  head: () =>
    pageHead({
      title: "How the office runs · Vantage-ARS",
      description:
        "Ten agents run the Vantage-ARS desk. A real enquiry can be quoted, accepted, invoiced and delivered without a person in the loop. Ending a subscription, spending money, and paying the founder still wait.",
      path: "/model",
    }),
  component: ModelPage,
});

const FLOOR = [
  ["FOYER", "Reception", "Classifies inbound. Does not sell."],
  ["SIGNAL", "Marketing", "Qualifies demand, then stops."],
  ["CLOSE", "Sales", "Drafts the quote after a handoff."],
  ["DESK", "Service", "Acknowledges faults. Does not concede."],
  ["FORGE", "Technical", "Writes the procedure. Does not spend."],
  ["LEDGER", "Finance", "Invoices from records. Cash out waits."],
  ["KEEP", "Admin", "Files. Does not sign."],
  ["VANTAGE", "Orchestrator", "Coordinates. Does not sell or spend."],
  ["SEAL", "Compliance", "Can veto an off-role action."],
  ["KEY", "Credentials", "Checks the Cloudflare token. Cannot replace it."],
] as const;

const PATH = [
  ["Enquiry", "FOYER records what was actually written."],
  ["Qualify", "SIGNAL scores it. A sale stops here."],
  ["Handoff", "The founder, or a standing delegation, moves it to sales."],
  ["Quote", "CLOSE drafts scope and total from the published rate."],
  ["Accept", "The customer accepts in writing. Nothing starts before that."],
  ["Do the work", "FORGE and DESK stay inside the accepted scope."],
  ["Invoice", "LEDGER bills only recorded work."],
  ["Receipt", "Money is booked when it is confirmed, not when it is claimed."],
] as const;

const ALONE = [
  "Open a sale for someone who wrote in.",
  "Quote a published rate and email that quote.",
  "Mark the work won after the customer accepts it.",
  "Invoice the accepted work and match an exact payment.",
  "Start a published subscription and send the report.",
  "Brief the founder from the office's own records.",
];

const WAITS = [
  "Any single action over R5,000, or more than 20 actions in a day.",
  "A price that is not on the published card.",
  "A customer who never wrote in.",
  "Ending a subscription.",
  "Any cost: ads, hardware, a vendor, a carrier.",
  "Paying the founder. There is no remittance agent.",
];

function ModelPage() {
  return (
    <PublicFrame>
      <section className="enter-up pb-12 pt-16 lg:pt-24">
        <p className="font-mono text-xs tracking-[0.22em] text-accent uppercase">The office</p>
        <h1 className="mt-4 max-w-3xl font-serif text-5xl leading-[0.98] tracking-[-0.03em] sm:text-7xl">
          It runs itself. It does not spend itself.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
          Ten agents work a queue every ten minutes. For a person who actually wrote in, the office
          may quote a published rate, email them, and — once they accept — invoice, match an exact
          payment, and deliver. Anything over R5,000, ending a subscription, spending money, and
          paying the founder still wait.
        </p>
      </section>

      <section className="border-t border-border py-16" aria-labelledby="floor-heading">
        <h2 id="floor-heading" className="font-serif text-4xl tracking-[-0.03em] sm:text-5xl">
          Who does the work
        </h2>
        <p className="mt-4 max-w-2xl text-muted">
          Each agent has one department. SEAL can stop the others. The governor sits in front of
          every action.
        </p>
        <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FLOOR.map(([sign, title, note], index) => (
            <li key={sign} className="panel rounded-2xl p-5">
              <p className="font-mono text-xs text-subtle">{String(index + 1).padStart(2, "0")}</p>
              <p className="mt-3 font-mono text-sm tracking-[0.16em] text-accent">{sign}</p>
              <h3 className="mt-1 font-serif text-2xl">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{note}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-t border-border py-16" aria-labelledby="path-heading">
        <h2 id="path-heading" className="font-serif text-4xl tracking-[-0.03em] sm:text-5xl">
          From enquiry to a confirmed receipt
        </h2>
        <ol className="mt-8 grid gap-3 md:grid-cols-2">
          {PATH.map(([title, note], index) => (
            <li key={title} className="flex gap-4 border-b border-border py-4">
              <span className="font-mono text-sm text-accent">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <span className="block font-semibold text-fg">{title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-muted">{note}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-muted">
          A payment notice on the site records a claim. It does not mark the invoice paid.
        </p>
      </section>

      <section className="border-t border-border py-16" aria-labelledby="gates-heading">
        <h2 id="gates-heading" className="font-serif text-4xl tracking-[-0.03em] sm:text-5xl">
          What runs alone, and what waits
        </h2>
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <div className="panel rounded-2xl p-6">
            <h3 className="font-mono text-xs tracking-[0.18em] text-ok uppercase">
              Runs on the schedule
            </h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed">
              {ALONE.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="panel rounded-2xl p-6">
            <h3 className="font-mono text-xs tracking-[0.18em] text-accent uppercase">
              Stops for a decision
            </h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed">
              {WAITS.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-8 text-sm text-muted">
          The seven published lines, and the rates under them, are on{" "}
          <Link to="/services" className="text-accent underline-offset-4 hover:underline">
            Services
          </Link>{" "}
          and{" "}
          <Link to="/rates" className="text-accent underline-offset-4 hover:underline">
            Rates
          </Link>
          . A new product is not added here.
        </p>
      </section>
    </PublicFrame>
  );
}
