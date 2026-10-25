/**
 * Duty runners — the execution half of autonomy.
 *
 * A runner receives one real work item and does the real thing it describes,
 * through the same governor every agent action goes through. A runner may NOT:
 *   - send email to a customer,
 *   - spend money,
 *   - win or lose a customer,
 *   - publish anything the founder has not approved.
 *
 * It may write drafts, open tickets, advance records the founder has already
 * authorised, and raise approvals. That boundary is what makes "runs by itself"
 * safe rather than reckless.
 */
import { randomUUID } from "node:crypto";
import { getSql } from "../db";
import {
  applyProposedAction,
  findInvoiceForReference,
  markCyclePaid,
  readDelegation,
  setOfficeHalt,
} from "./store.server";
import { sendCustomerMail } from "./smtp.server";
import { heartbeat } from "./office-view.server";
import { formatZar } from "./money";
import { PRICE_GUIDE, rateCardIntegrity } from "./duties";
import { COMPANY } from "./company";
import { planById } from "./plans";
import { cycleWindow, nextCycleStart } from "./subscription";
import { buildServiceReport, summariseService } from "./fulfilment";
import { collectServiceFacts } from "./service-facts.server";
import { anchorIfDue } from "./anchor.server";

import { resolveRecipient } from "./customer-notice.server";
import type { WorkItem } from "./work-queue.server";
import type { DutyView, PlannedWork } from "./duties";
import { scoreLead } from "./duties";

export type DutyResult = {
  outcome: string;
  /** Actions actually executed through the governor. */
  executed: number;
  escalated: number;
  blocked: number;
};

type Runner = (item: WorkItem, view: DutyView) => Promise<DutyResult>;

function noop(outcome: string): DutyResult {
  return { outcome, executed: 0, escalated: 0, blocked: 0 };
}

async function fileDocument(input: {
  title: string;
  kind: string;
  status?: string;
  summary: string;
  relatedId?: string | null;
}): Promise<string> {
  const sql = await getSql();
  const id = randomUUID();
  await sql`
    insert into documents (id, title, kind, status, summary, related_id)
    values (${id}, ${input.title}, ${input.kind}, ${input.status ?? "draft"}, ${input.summary}, ${input.relatedId ?? null})
  `;
  return id;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Read a rand figure the office itself wrote, in cents.
 *
 * `formatZar` renders "R 2 750,00" with a non-breaking space and a comma
 * decimal point. The number is stripped of every space, the last separator is
 * read as the decimal point, and the result is rounded to whole cents.
 */
function parseClaimedCents(value: string): number {
  const cleaned = value
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(/[^\d.,]/g, "")
    .replace(/[.,]+$/, "");
  if (!cleaned) return 0;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalised: string;
  if (lastComma > lastDot) {
    normalised = `${cleaned.slice(0, lastComma).replace(/[.,]/g, "")}.${cleaned.slice(lastComma + 1)}`;
  } else if (lastDot > lastComma) {
    normalised = `${cleaned.slice(0, lastDot).replace(/[.,]/g, "")}.${cleaned.slice(lastDot + 1)}`;
  } else {
    normalised = cleaned.replace(/[.,]/g, "");
  }
  const amount = Number(normalised);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
}

function intOf(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── VANTAGE ───────────────────────────────────────────────────────────────────

const watchCloudflareToken: Runner = async (item) => {
  const { inspectCloudflareToken } = await import("./token-watch.server");
  const verdict = await inspectCloudflareToken();
  if (verdict.state === "accepted") {
    return noop("Cloudflare accepted the token. The value was not recorded.");
  }
  const result = await applyProposedAction(
    "key",
    {
      kind: "notify_operator",
      title: "The Cloudflare token needs a person",
      rationale: `${verdict.detail} ${item.reason}`,
      confidence: 0.95,
      amountCents: 0,
      payload: { state: verdict.state },
    },
    { source: "scheduler", workItem: item.id },
  );
  await sendFounderAlert(
    "The Cloudflare token needs a person",
    `${verdict.detail} KEY cannot create a replacement. Set a dashboard API token on the host.`,
    "/office",
  );
  return {
    outcome: `Cloudflare token ${verdict.state}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const reportSilentAgent: Runner = async (item) => {
  const result = await applyProposedAction(
    "vantage",
    {
      kind: "notify_operator",
      title: `${str(item.payload.silentAgent).toUpperCase()} has gone quiet`,
      rationale: item.reason,
      confidence: 0.9,
      amountCents: 0,
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `${result.status}: ${item.reason}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const reportStuckBacklog: Runner = async (item) => {
  const stuck = Array.isArray(item.payload.stuck)
    ? (item.payload.stuck as { agentId: string; kind: string }[])
    : [];
  const result = await applyProposedAction(
    "vantage",
    {
      kind: "notify_operator",
      title: `Work backlog is stuck (${stuck.length} items)`,
      rationale: item.reason,
      confidence: 0.95,
      amountCents: 0,
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Stuck backlog reported: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const reportAbandonedWork: Runner = async (item) => {
  const result = await applyProposedAction(
    "vantage",
    {
      kind: "notify_operator",
      title: "Work items exhausted their retries",
      rationale: item.reason,
      confidence: 0.95,
      amountCents: 0,
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Abandoned work reported: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/**
 * The daily briefing. Every figure below is read from a real row at the moment
 * the briefing is written — money from the company books, pipeline from the
 * lead and opportunity tables, activity from the run log. Nothing is estimated,
 * rounded up, or carried over from the last briefing.
 */
const reportDailyBriefing: Runner = async (item, _view) => {
  const sql = await getSql();
  const date = str(item.payload.date) || new Date().toISOString().slice(0, 10);

  const books = await sql<Record<string, unknown>>`
    select treasury_cents, receivable_cents, payable_cents from company_state where id = ${COMPANY.id}
  `.then((rows) => rows[0] ?? {});
  const leads = await sql<{ stage: string; n: number }>`
    select stage, count(*)::int as n from leads group by stage order by stage
  `;
  const pipeline = await sql<{ stage: string; n: number; value_cents: number }>`
    select stage, count(*)::int as n, coalesce(sum(value_cents), 0)::int as value_cents
    from opportunities where stage not in ('lost') group by stage order by stage
  `;
  const approvals = await sql<{ n: number }>`
    select count(*)::int as n from approvals where status = 'pending'
  `.then((rows) => Number(rows[0]?.n ?? 0));
  const queue = await sql<{ open: number; claimed: number; abandoned: number }>`
    select
      count(*) filter (where status = 'open')::int as open,
      count(*) filter (where status = 'claimed')::int as claimed,
      count(*) filter (where status = 'abandoned')::int as abandoned
    from work_items
  `.then((rows) => rows[0] ?? { open: 0, claimed: 0, abandoned: 0 });
  const activity = await sql<{ n: number; executed: number; escalated: number; failed: number }>`
    select
      count(*)::int as n,
      coalesce(sum(executed), 0)::int as executed,
      coalesce(sum(escalated), 0)::int as escalated,
      count(*) filter (where status = 'error')::int as failed
    from agent_runs
    where started_at > now() - interval '24 hours'
  `.then((rows) => rows[0] ?? { n: 0, executed: 0, escalated: 0, failed: 0 });
  const openTickets = await sql<{ n: number }>`
    select count(*)::int as n from tickets where status != 'resolved'
  `.then((rows) => Number(rows[0]?.n ?? 0));
  const campaigns = await sql<{ status: string; n: number }>`
    select status, count(*)::int as n from campaigns group by status order by status
  `;
  const visits = await sql<{ n: number }>`
    select count(*)::int as n from site_events where occurred_at > now() - interval '24 hours'
  `.then((rows) => Number(rows[0]?.n ?? 0));

  const lines = [
    `Books: treasury ${formatZar(Number(books.treasury_cents ?? 0))}, receivable ${formatZar(Number(books.receivable_cents ?? 0))}, payable ${formatZar(Number(books.payable_cents ?? 0))}.`,
    `Waiting on you: ${approvals} approval(s).`,
    leads.length
      ? `Leads: ${leads.map((row) => `${row.n} ${row.stage}`).join(", ")}.`
      : "Leads: none on file.",
    pipeline.length
      ? `Open pipeline: ${pipeline.map((row) => `${row.n} in ${row.stage} (${formatZar(Number(row.value_cents))})`).join(", ")}.`
      : "Open pipeline: empty.",
    `Last 24 hours: ${Number(activity.n)} run(s), ${Number(activity.executed)} action(s) executed, ${Number(activity.escalated)} put to you, ${Number(activity.failed)} failed.`,
    `Queue now: ${Number(queue.open)} open, ${Number(queue.claimed)} claimed, ${Number(queue.abandoned)} abandoned.`,
    `Service: ${openTickets} open ticket(s). Campaigns: ${campaigns.length ? campaigns.map((row) => `${row.n} ${row.status}`).join(", ") : "none"}. Site: ${visits} recorded visit(s) in the last 24 hours.`,
  ];

  const result = await applyProposedAction(
    "vantage",
    {
      kind: "notify_operator",
      title: `Daily briefing · ${date}`,
      rationale: lines.join("\n"),
      confidence: 0.98,
      amountCents: 0,
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );

  const { deliverFounderNotice } = await import("./notify.server");
  const { founderBriefingNotice } = await import("./notice");
  await deliverFounderNotice(founderBriefingNotice({ date, lines }));

  return {
    outcome: `Briefed the founder for ${date}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

// ── FOYER ─────────────────────────────────────────────────────────────────────

const routeInbound: Runner = async (item) => {
  const inboundId = str(item.payload.inboundId);
  const result = await applyProposedAction(
    "foyer",
    {
      kind: "route_inbound",
      title: `Route ${str(item.payload.intent) || "enquiry"} from ${str(item.payload.companyName)}`,
      rationale: item.reason,
      confidence: 0.92,
      amountCents: 0,
      companyName: str(item.payload.companyName),
      relatedId: inboundId,
      payload: { routedTo: str(item.payload.intent) === "support" ? "desk" : "signal" },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Routed ${inboundId}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/**
 * Classify a real enquiry and file it as a lead or a support ticket.
 *
 * The classification is deterministic and explainable — it reads what the person
 * actually wrote. Nothing is guessed about a company that is not on the record.
 */
const classifyInbound: Runner = async (item) => {
  const inboundId = str(item.payload.inboundId);
  const companyName = str(item.payload.companyName) || "Unnamed enquiry";
  const summary = str(item.payload.summary);
  const declared = str(item.payload.intent);

  // The buyer's own words, minus our own routing header. This is what the lead
  // and the ticket are built from, and what every later duty scores.
  const customerWords = summary
    .replace(/^Email:.*$/im, "")
    .replace(/^Source:.*$/im, "")
    .replace(/^Matter:.*$/im, "")
    .trim()
    .slice(0, 3000);

  if (declared === "payment_notice") {
    const result = await applyProposedAction(
      "foyer",
      {
        kind: "route_inbound",
        title: `Payment notice from ${companyName}`,
        rationale: "Customer says they paid. Ledger holds the notice; no receipt is booked.",
        confidence: 0.95,
        amountCents: 0,
        companyName,
        relatedId: inboundId,
        payload: { routedTo: "ledger" },
      },
      { source: "scheduler", workItem: item.id },
    );
    return {
      outcome: `Payment notice routed to ledger: ${result.status}`,
      executed: result.status === "executed" ? 1 : 0,
      escalated: result.status === "escalated" ? 1 : 0,
      blocked: result.status === "blocked" ? 1 : 0,
    };
  }

  const looksLikeSupport =
    declared === "support" ||
    /\b(fault|broken|not working|down|outage|no dial|no internet|dropping|intermittent)\b/i.test(
      summary,
    );

  const result = looksLikeSupport
    ? await applyProposedAction(
        "foyer",
        {
          kind: "open_ticket",
          title: `Service request · ${companyName}`,
          rationale: customerWords || item.reason,
          confidence: 0.85,
          amountCents: 0,
          companyName,
          relatedId: inboundId,
          payload: { owner: "desk", severity: "p2" },
        },
        { source: "scheduler", workItem: item.id },
      )
    : await applyProposedAction(
        "foyer",
        {
          kind: "create_lead",
          title: `Enquiry · ${companyName}`,
          rationale: customerWords || item.reason,
          confidence: 0.8,
          amountCents: 0,
          companyName,
          relatedId: inboundId,
          payload: {
            source: `site:${str(item.payload.channel)}`,
            stage: "engaged",
            score: 50,
            evidence: customerWords,
          },
        },
        { source: "scheduler", workItem: item.id },
      );

  return {
    outcome: `${looksLikeSupport ? "Opened a service ticket" : "Filed a lead"} for ${companyName}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const escalateStaleEnquiry: Runner = async (item) => {
  const result = await applyProposedAction(
    "foyer",
    {
      kind: "notify_operator",
      title: `Enquiry from ${str(item.payload.companyName)} is ${str(item.payload.ageHours)}h old`,
      rationale: item.reason,
      confidence: 0.95,
      amountCents: 0,
      companyName: str(item.payload.companyName),
      relatedId: str(item.payload.inboundId),
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Founder notified about a stale enquiry: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

// ── SIGNAL (marketing) ────────────────────────────────────────────────────────

const analyseSiteSignals: Runner = async (item, view) => {
  const byPath = new Map<string, number>();
  for (const event of view.siteEvents) byPath.set(event.path, (byPath.get(event.path) ?? 0) + 1);
  const ranked = [...byPath.entries()].sort((a, b) => b[1] - a[1]);
  const total = view.siteEvents.length;
  const inboundCount = view.inbound.length;
  const conversion = total === 0 ? 0 : (inboundCount / total) * 100;

  const summary = [
    `Real site traffic over the last 30 days: ${total} recorded event(s) across ${ranked.length} path(s).`,
    ranked.length
      ? `Top paths: ${ranked
          .slice(0, 6)
          .map(([path, n]) => `${path} (${n})`)
          .join(", ")}.`
      : "No page views were recorded, so nothing can be said about which pages work.",
    inboundCount > 0
      ? `${inboundCount} real enquiry/payment item(s) reached the office from those visits (${conversion.toFixed(1)}% of recorded events).`
      : "No enquiries have arrived from the site yet. Traffic without an enquiry is not pipeline.",
    rateCardIntegrity().detail,
    "Channels: the office publishes on its own site only. No media is bought and no budget is committed.",
  ].join("\n");

  const id = await fileDocument({
    title: `Site signals · ${new Date().toISOString().slice(0, 10)}`,
    kind: "internal",
    summary,
  });
  void id;
  return noop(`Recorded a site-signal note from ${total} real events.`);
};

const prospectFromSiteSignals: Runner = async (item, _view) => {
  const path = str(item.payload.path);
  const count = intOf(item.payload.visitCount, 1);
  const scored = scoreLead(
    `${count} recorded visit(s) to ${path} with no enquiry filed yet.`,
    `Prospect · ${path}`,
  );
  const result = await applyProposedAction(
    "signal",
    {
      kind: "create_lead",
      title: `Prospect · ${path}`,
      rationale: `Repeat interest from the site: ${count} recorded visit(s) to ${path} with no enquiry filed. This is a flagged interest, not a confirmed buyer, and no customer contact is known.`,
      confidence: 0.75,
      amountCents: 0,
      companyName: `Prospect · ${path}`,
      payload: {
        source: "site_signal",
        stage: "engaged",
        score: scored.score,
        evidence: `${count} recorded visit(s) to ${path}; no enquiry follows them yet.`,
      },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Prospected ${path}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const writeContentBrief: Runner = async (item, view) => {
  const cheapest = [...PRICE_GUIDE].sort((a, b) => a.cents - b.cents)[0];
  const paths = new Set(view.siteEvents.map((event) => event.path));
  const untouched = [
    "/rates",
    "/work",
    "/support",
    "/services/voip",
    "/services/networking",
    "/services/it-infrastructure",
    "/services/managed-support",
    "/services/cloud-email",
    "/services/security",
    "/services/backup-recovery",
  ].filter((path) => !paths.has(path));
  const summary = [
    `Brief for the next owned-site piece. Written because ${item.reason}`,
    "",
    `Audience: an office or operator who runs real VoIP, networking and IT infrastructure and is tired of vague answers.`,
    `The page must earn its place by answering a question a buyer actually asks. It must not claim 24/7 cover, certifications, response times or a lowest price — ${COMPANY.legalName} cannot evidence those.`,
    `It must quote only published labour: ${cheapest.price} (${cheapest.title}) and the rest of the rate card. Managed support is not offered and must not be implied.`,
    "",
    untouched.length
      ? `Pages with no recorded traffic in this window: ${untouched.join(", ")}. Check whether they are unreachable, unlinked, or simply unwanted before writing anything new.`
      : "Every published service page has recorded traffic. Extend what is working rather than adding a new page.",
    "",
    "Publication is a founder decision. This brief is a draft until it is approved.",
  ].join("\n");
  await fileDocument({
    title: `Content brief · ${new Date().toISOString().slice(0, 10)}`,
    kind: "content_brief",
    summary,
  });
  return noop("Wrote a content brief for the founder to approve.");
};

const qualifyLead: Runner = async (item) => {
  const leadId = str(item.payload.leadId);
  const score = intOf(item.payload.score, 40);
  const reasons = Array.isArray(item.payload.reasons) ? (item.payload.reasons as string[]) : [];
  const spam = item.payload.spam === true;
  const stage = spam ? "disqualified" : score >= 45 ? "qualified" : "nurture";
  const summary = spam
    ? `Disqualified: ${reasons.join("; ") || "reads as unsolicited outreach"}.`
    : `Score ${score}/100. ${reasons.join("; ") || "No demand signal found."}`;

  const result = await applyProposedAction(
    "signal",
    {
      kind: "update_lead",
      title: `${stage === "disqualified" ? "Disqualified" : "Scored"} ${str(item.payload.companyName) || leadId}`,
      rationale: summary,
      confidence: spam ? 0.92 : 0.8,
      amountCents: 0,
      relatedId: leadId,
      // The score is the office's opinion; the lead's summary is the buyer's
      // words, and stays that way so later duties score the customer, not us.
      payload: { stage, score, keepSummary: true },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `${leadId} → ${stage}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const proposeSalesHandoff: Runner = async (item) => {
  const leadId = str(item.payload.leadId);
  const companyName = str(item.payload.companyName);
  const reasons = Array.isArray(item.payload.reasons) ? (item.payload.reasons as string[]) : [];
  const result = await applyProposedAction(
    "signal",
    {
      kind: "handoff_to_sales",
      title: `Hand ${companyName} to sales`,
      rationale: `Marketing stops here. ${reasons.join("; ")} Score ${str(item.payload.score)}/100. The founder decides whether this becomes a sale.`,
      confidence: 0.78,
      amountCents: 0,
      companyName,
      relatedId: leadId,
      payload: { score: intOf(item.payload.score, 0) },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Handoff proposed for ${companyName}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const draftCampaign: Runner = async (item) => {
  const channel = str(item.payload.channel, "owned");
  const leads = Array.isArray(item.payload.leads)
    ? (item.payload.leads as { id: string; companyName: string; stage: string; score: number }[])
    : [];
  const result = await applyProposedAction(
    "signal",
    {
      kind: "draft_campaign",
      title: `Owned-channel campaign · ${new Date().toISOString().slice(0, 10)}`,
      rationale: [
        `Draft campaign for ${leads.length} nurtured lead(s) who are not yet in sales.`,
        ...leads.map((lead) => `- ${lead.companyName} (${lead.stage}, score ${lead.score})`),
        "This is organic, owned-channel work. No media is bought and no budget is committed. Activation and any spend wait on your approval.",
      ].join("\n"),
      confidence: 0.8,
      amountCents: 0,
      payload: { channel, budgetCents: 0, leads },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Campaign drafted: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

// ── CLOSE (sales) ─────────────────────────────────────────────────────────────

const advanceDiscovery: Runner = async (item) => {
  const opportunityId = str(item.payload.opportunityId);
  const companyName = str(item.payload.companyName);
  const sql = await getSql();
  const checklistTitle = `Discovery checklist · ${companyName}`;
  // Discovery is a one-time pack, not a per-tick ritual. If the checklist is
  // already on file the work is done, even though the opportunity stays in
  // discovery until it can be priced.
  const existing = await sql<{ id: string }>`
    select id from documents
    where kind = 'internal' and related_id = ${opportunityId} and title = ${checklistTitle}
    limit 1
  `;
  if (existing.length) {
    return noop(`Discovery for ${companyName} is already on file.`);
  }
  const result = await applyProposedAction(
    "close",
    {
      kind: "advance_opportunity",
      title: `Discovery pack prepared for ${companyName}`,
      rationale: [
        "Discovery for a VoIP, networking or infrastructure enquiry.",
        "Before a figure can be quoted, these must be confirmed: the systems in scope, who administers them, the access the work needs, the acceptance check, and the schedule the customer can accept.",
        `${COMPANY.legalName} quotes published labour only. Ranges, retainers, travel and supplier charges are quoted separately and approved by the founder.`,
        "The next step is a written scope and a priced quote, both approved before work starts.",
      ].join(" "),
      confidence: 0.8,
      amountCents: 0,
      companyName,
      relatedId: opportunityId,
      // Keep the buyer's summary and the current value: a discovery pack is not
      // a re-pricing, and overwriting them loses the enquiry detail the quote
      // playbook later reads.
      payload: { stage: "discovery", keepSummary: true },
    },
    { source: "scheduler", workItem: item.id },
  );
  if (result.status === "executed") {
    await fileDocument({
      title: checklistTitle,
      kind: "internal",
      status: "draft",
      summary: [
        `Discovery checklist for ${companyName}.`,
        "1. Which systems are in scope, and which are explicitly not?",
        "2. Who administers them, and do we have lawful access?",
        "3. What is the acceptance check for 'fixed'?",
        "4. What schedule can the customer accept?",
        "5. Which published rate applies: remote or on-site?",
        "6. Are travel, hardware, licences or carrier charges needed? They are quoted separately.",
      ].join("\n"),
      relatedId: opportunityId,
    });
  }
  return {
    outcome: `Discovery recorded for ${companyName}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/**
 * Follow up on a real, waiting quote. The letter is a DRAFT: it is written to the
 * documents table for the founder to review and send. Nothing is emailed here,
 * because an unreviewed message to a customer is a commitment the office cannot
 * make on the founder's behalf.
 */
const draftQuoteFollowUp: Runner = async (item) => {
  const companyName = str(item.payload.companyName);
  const days = intOf(item.payload.daysWaiting, 1);
  const views = intOf(item.payload.views, 0);
  const value = intOf(item.payload.valueCents, 0);
  const letter = [
    `Hello ${companyName},`,
    "",
    `Following up on the quote ${str(item.payload.quoteId)} issued ${days} day${days === 1 ? "" : "s"} ago.`,
    views > 0
      ? "The link was opened but nothing has come back yet, so we are checking the scope and figures still stand."
      : "We have not seen the quote opened, so we are checking that it arrived and that the figures are still right.",
    "",
    "Nothing has changed: the scope, the labour rate, and the exclusions are as written. If any part of it does not match what you actually need, tell us what differs and we will requote rather than defend it.",
    "",
    "If the work has moved on, a short note saying so is genuinely useful and we will close the file cleanly.",
    "",
    `${COMPANY.legalName}`,
  ].join("\n");

  await fileDocument({
    title: `Quote follow-up · ${companyName} · ${days}d`,
    kind: "follow_up",
    status: "draft",
    summary: letter,
    relatedId: str(item.payload.opportunityId),
  });
  return noop(
    `Drafted a follow-up for ${companyName} (${formatZar(value)}, ${days}d, ${views} view(s)). Not emailed.`,
  );
};

const reviewColdProposal: Runner = async (item) => {
  const result = await applyProposedAction(
    "close",
    {
      kind: "notify_operator",
      title: `Cold proposal · ${str(item.payload.companyName)}`,
      rationale: `${item.reason} Sales may not mark this lost without the founder deciding.`,
      confidence: 0.75,
      amountCents: 0,
      companyName: str(item.payload.companyName),
      relatedId: str(item.payload.opportunityId),
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Cold proposal reported: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const nudgeInvoice: Runner = async (item) => {
  const result = await applyProposedAction(
    "close",
    {
      kind: "notify_operator",
      title: `${str(item.payload.companyName)} is won and ready to invoice`,
      rationale: `${item.reason} Ledger raises the invoice; Sales cannot book one.`,
      confidence: 0.9,
      amountCents: 0,
      companyName: str(item.payload.companyName),
      relatedId: str(item.payload.opportunityId),
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Invoice nudge raised: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

// ── DESK (customer service) ───────────────────────────────────────────────────

const acknowledgeTicket: Runner = async (item) => {
  const ticketId = str(item.payload.ticketId);
  const letter = [
    "We have your service request and it is on the board.",
    "Nothing is confirmed yet: not a cause, not a fix, not a time. Those come from the work, not from this note.",
    "If anything changes that affects the site, tell us and we will use the updated information.",
  ].join("\n");
  const sql = await getSql();
  const ticket = await sql<{ related_id: string | null; summary: string }>`
    select related_id, summary from tickets where id = ${ticketId}
  `.then((rows) => rows[0]);
  if (!ticket) return noop("Ticket no longer exists.");
  const companyName = await resolveCompany(ticket.related_id);
  const id = await fileDocument({
    title: `Service acknowledgement · ${ticketId.slice(0, 8)}`,
    kind: "service_ack",
    status: "draft",
    summary: letter,
    relatedId: ticketId,
  });
  const result = await applyProposedAction(
    "desk",
    {
      kind: "update_ticket",
      title: `Acknowledged · ${str(item.payload.title)}`,
      rationale: `Customer acknowledgement drafted as ${id}. It has not been sent.`,
      confidence: 0.85,
      amountCents: 0,
      companyName,
      relatedId: ticketId,
      payload: { status: "in_progress" },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Acknowledged ${ticketId.slice(0, 8)}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const escalateAgeingTicket: Runner = async (item) => {
  const result = await applyProposedAction(
    "desk",
    {
      kind: "escalate_account_risk",
      title: `Ageing service request · ${str(item.payload.title)}`,
      rationale: `${item.reason} No refund, credit, cancellation or new commitment is made here.`,
      confidence: 0.9,
      amountCents: 0,
      relatedId: str(item.payload.ticketId),
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Ageing ticket escalated: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const draftChatReply: Runner = async (item) => {
  const name = str(item.payload.name) || "there";
  const threadId = str(item.payload.threadId);
  const { readChat } = await import("./chat.server");
  const messages = await readChat(threadId);
  const lastCustomer = [...messages].reverse().find((message) => message.role === "customer");
  const question = lastCustomer?.body ?? "";
  const letter = [
    `Hello ${name},`,
    "",
    "Thanks for the message. It has reached the desk and is on file.",
    question
      ? `On your question — "${question.slice(0, 200)}" — the honest answer is that we need to look at the system before we say anything definitive. We will come back with what we find, not with a guess.`
      : "We will come back to you once we have looked at it properly.",
    "",
    "We are not going to quote a cause, a fix or a time from a chat window.",
    "",
    `${COMPANY.legalName}`,
  ].join("\n");
  await fileDocument({
    title: `Chat reply · ${name}`,
    kind: "correspondence",
    status: "draft",
    summary: letter,
  });
  return noop(`Drafted a chat reply for ${name}. Not sent.`);
};

// ── FORGE (technical) ─────────────────────────────────────────────────────────

const diagnoseTicket: Runner = async (item) => {
  const { technicalFix } = await import("./floor");
  const procedure = technicalFix(str(item.payload.summary));
  const sql = await getSql();
  const claimed = await sql<{ id: string }>`
    update tickets
    set status = 'in_progress', summary = ${procedure}, updated_at = now()
    where id = ${str(item.payload.ticketId)} and status = 'open'
    returning id
  `;
  if (!claimed.length) return noop("Ticket was already being worked.");
  const result = await applyProposedAction(
    "forge",
    {
      kind: "update_ticket",
      title: `Procedure written · ${str(item.payload.title)}`,
      rationale: procedure,
      confidence: 0.85,
      amountCents: 0,
      relatedId: str(item.payload.ticketId),
      payload: { status: "in_progress" },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Procedure written for ${str(item.payload.ticketId).slice(0, 8)}: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const recordKnowledge: Runner = async (item) => {
  const sql = await getSql();
  const ticket = await sql<{ summary: string; title: string }>`
    select summary, title from tickets where id = ${str(item.payload.ticketId)}
  `.then((rows) => rows[0]);
  if (!ticket) return noop("Ticket no longer exists.");
  const body = ticket.summary
    .replace(/^FORGE:\s*/, "")
    .split("Customer equipment")[0]
    .trim();
  await fileDocument({
    title: `Known fault · ${ticket.title}`,
    kind: "knowledge",
    status: "recorded",
    summary: `# ${ticket.title}\n\n${body}\n\nThis is a procedure, not a claim that the fault was fixed. Customer equipment was not accessed from this office.`,
    relatedId: str(item.payload.ticketId),
  });
  return noop("Recorded the procedure in the knowledge base.");
};

// ── LEDGER (finance) ──────────────────────────────────────────────────────────

const draftInvoiceChase: Runner = async (item) => {
  const counterparty = str(item.payload.counterparty);
  const amount = intOf(item.payload.amountCents, 0);
  const { invoiceCopy } = await import("./invoice");
  const reference = str(item.payload.invoiceId);
  const letter = [
    `Hello ${counterparty},`,
    "",
    `Our invoice ${reference} for ${formatZar(amount)} has been outstanding since we issued it.`,
    "This is a reminder, not a demand and not a statement that anything is wrong. If the invoice is not what you expected, say so and we will look at it before anything else.",
    "If payment is already on its way, ignore this and it will clear on our side.",
    "",
    "No interest, penalty or credit note is applied by this message.",
    "",
    `${COMPANY.legalName}`,
  ].join("\n");
  void invoiceCopy;
  await fileDocument({
    title: `Invoice reminder · ${counterparty} · ${formatZar(amount)}`,
    kind: "follow_up",
    status: "draft",
    summary: letter,
    relatedId: reference,
  });
  return noop(
    `Drafted an invoice reminder for ${counterparty} (${formatZar(amount)}). Not emailed.`,
  );
};

/**
 * A payment notice.
 *
 * Normally this waits for the founder: cash only moves when a person confirms
 * it arrived. But when the founder has delegated it, and the notice names an
 * invoice that is still open by its exact reference and its exact amount, the
 * office can match it on its own. Anything less than an exact match still goes
 * to the founder.
 */
const verifyPaymentNotice: Runner = async (item) => {
  const sql = await getSql();
  const inboundId = str(item.payload.inboundId);
  const companyName = str(item.payload.companyName);

  const inbound = await sql<{ summary: string }>`
    select summary from inbound_items where id = ${inboundId}
  `.then((rows) => rows[0]);
  const summary = String(inbound?.summary ?? "");
  const reference = /Reference\s+(VA-[A-Z0-9]+)/i.exec(summary)?.[1]?.toUpperCase() ?? null;
  // The office writes the figure with `formatZar`, which uses a non-breaking
  // space as the thousands separator: "Claimed R 2 750,00". Stripping the
  // spaces and reading the comma as the decimal point is the only way to read
  // it back correctly.
  const claimed = /Claimed\s*R\s*([\d\u00a0\u202f\s.,]*\d)/i.exec(summary)?.[1];
  const claimedCents = claimed ? parseClaimedCents(claimed) : 0;

  const delegation = await readDelegation();
  const mayReconcile =
    Boolean(delegation) &&
    delegation?.status === "active" &&
    delegation?.allowAutoReconcile === true &&
    (delegation?.allowedActions ?? []).includes("record_inbound_payment");

  if (mayReconcile && reference && claimedCents > 0) {
    const invoice = await findInvoiceForReference(reference);
    if (invoice && invoice.amountCents === claimedCents) {
      const receipt = await applyProposedAction(
        "ledger",
        {
          kind: "record_inbound_payment",
          title: `Receipt · ${invoice.companyName} · ${reference}`,
          rationale: `The customer paid ${formatZar(claimedCents)} against ${reference}, which matches an open invoice to the cent.`,
          confidence: 0.96,
          amountCents: claimedCents,
          companyName: invoice.companyName,
          relatedId: invoice.id,
          payload: { reference, inboundId },
        },
        { source: "scheduler", workItem: item.id, autonomous: true },
      );
      if (receipt.status === "executed") {
        await sql`update ledger_entries set status = 'paid' where id = ${invoice.id} and kind = 'invoice'`;
        await sql`update inbound_items set status = 'filed' where id = ${inboundId}`;
        await markCyclePaid(invoice.relatedId ?? invoice.id);
        return {
          outcome: `Matched ${formatZar(claimedCents)} to ${reference} and recorded the receipt.`,
          executed: 1,
          escalated: 0,
          blocked: 0,
        };
      }
    }
  }

  const result = await applyProposedAction(
    "ledger",
    {
      kind: "notify_operator",
      title: `Payment notice to confirm · ${companyName}`,
      rationale: `${item.reason} Treasury only moves when the founder confirms the money actually arrived, against an invoice that exists.`,
      confidence: 0.95,
      amountCents: 0,
      companyName,
      relatedId: inboundId,
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Payment notice flagged for confirmation: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const reportPayables: Runner = async (item) => {
  const result = await applyProposedAction(
    "ledger",
    {
      kind: "notify_operator",
      title: "Payables need a payment decision",
      rationale: `${item.reason} Ledger may not schedule a payment. That is a founder decision.`,
      confidence: 0.95,
      amountCents: 0,
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Payables reported: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

// ── KEEP (admin) ──────────────────────────────────────────────────────────────

const fileMissingRecords: Runner = async (item) => {
  const result = await applyProposedAction(
    "keep",
    {
      kind: "notify_operator",
      title: `Records incomplete · ${str(item.payload.companyName)}`,
      rationale: `${item.reason} Nothing is deleted and nothing is invented; the gap is reported so the founder can close it.`,
      confidence: 0.9,
      amountCents: 0,
      companyName: str(item.payload.companyName),
      relatedId: str(item.payload.opportunityId),
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Records gap reported: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

// ── SEAL (compliance) ─────────────────────────────────────────────────────────

/**
 * A broken audit chain stops the office. This is the one duty with the authority
 * to halt, because an office that cannot prove what it did must not keep acting
 * autonomously.
 */
const haltBrokenChain: Runner = async (item) => {
  await setOfficeHalt(true, `SEAL halted autonomous operations: ${item.reason}`);
  await sendFounderAlert(
    "The audit chain failed verification",
    `${item.reason} Autonomous actions are stopped. Resume from the office once the chain is understood.`,
    "/office/audit",
  );
  return noop("Office halted because the audit chain did not verify.");
};

const reportScopeDrift: Runner = async (item) => {
  const result = await applyProposedAction(
    "seal",
    {
      kind: "notify_operator",
      title: "Possible role drift detected",
      rationale: item.reason,
      confidence: 0.85,
      amountCents: 0,
      payload: {},
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Scope drift reported: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

const anchorChainHead: Runner = async (item) => {
  const sql = await getSql();
  const rows = await sql<{ last_audit_hash: string }>`
    select last_audit_hash from company_state where id = ${COMPANY.id}
  `;
  const head = String(rows[0]?.last_audit_hash ?? "");
  const anchor = await anchorIfDue(head);
  if (!anchor) {
    return noop("Audit chain head already anchored; nothing new to record.");
  }
  return noop(`Anchored audit-chain head ${head.slice(0, 12)} as ${anchor.id.slice(0, 8)}.`);
};

// ── Recurring revenue ─────────────────────────────────────────────────────────

/**
 * Bill a subscription period.
 *
 * The billing cycle row is the idempotency key: the unique index on
 * (subscription_id, period_start) means a retried tick, a restarted server or
 * two concurrent ticks cannot bill the same month twice. The invoice itself
 * goes through the governor, so the delegation caps and the money guards
 * apply exactly as they do to a founder-raised invoice.
 */
const billSubscriptionCycle: Runner = async (item) => {
  const sql = await getSql();
  const subscriptionId = str(item.payload.subscriptionId);
  const companyName = str(item.payload.companyName);
  const planId = str(item.payload.planId);
  const rateId = str(item.payload.rateId);
  const cycle = str(item.payload.cycle, "monthly");
  const priceCents = intOf(item.payload.priceCents);
  const periodStart = str(item.payload.periodStart) || new Date().toISOString();
  if (!subscriptionId || priceCents <= 0) {
    return noop("The subscription could not be billed: no subscription id or price.");
  }

  const window = cycleWindow(periodStart, cycle as never);
  const existing = await sql<{ id: string; status: string }>`
    select id, status from billing_cycles
    where subscription_id = ${subscriptionId} and period_start = ${periodStart}
    limit 1
  `;
  let cycleId: string;
  if (existing.length) {
    const status = existing[0].status;
    if (status !== "pending") {
      await advanceSubscription(sql, subscriptionId, window.end);
      return noop(
        `The ${planId} period starting ${periodStart.slice(0, 10)} was already billed (${status}).`,
      );
    }
    // The period exists but was never invoiced. If the founder is still looking
    // at the approval, wait for them instead of filing a second one every tick.
    const latestApproval = await sql<{ status: string }>`
      select status from approvals
      where action_json->>'kind' = 'issue_invoice'
        and (
          action_json->>'relatedId' = ${existing[0].id}
          or action_json->'payload'->>'cycleId' = ${existing[0].id}
        )
      order by created_at desc
      limit 1
    `.then((rows) => rows[0]);
    if (latestApproval?.status === "pending") {
      return noop(`The ${companyName} invoice is waiting on founder approval.`);
    }
    if (latestApproval?.status === "rejected") {
      // A refused invoice must not be re-proposed every ten minutes. Close the
      // period and move the subscription on; the founder can bill it by hand.
      await sql`
        update billing_cycles set status = 'cancelled'
        where id = ${existing[0].id} and status = 'pending'
      `;
      await advanceSubscription(sql, subscriptionId, window.end);
      return noop(`The founder rejected the ${companyName} invoice, so the period was closed.`);
    }
    cycleId = existing[0].id;
  } else {
    cycleId = randomUUID();
    await sql`
      insert into billing_cycles (
        id, subscription_id, company_name, plan_id, rate_id, period_start, period_end,
        amount_cents, status, created_at
      ) values (
        ${cycleId}, ${subscriptionId}, ${companyName}, ${planId}, ${rateId},
        ${periodStart}, ${window.end}, ${priceCents}, 'pending', now()
      )
      on conflict (subscription_id, period_start) do nothing
    `;
    const claimed = await sql<{ id: string }>`
      select id from billing_cycles
      where id = ${cycleId}
    `;
    if (!claimed.length) {
      await advanceSubscription(sql, subscriptionId, window.end);
      return noop(`The ${planId} period starting ${periodStart.slice(0, 10)} was already billed.`);
    }
  }

  const result = await applyProposedAction(
    "ledger",
    {
      kind: "issue_invoice",
      title: `Invoice · ${companyName} · ${planId}`,
      rationale: `Recurring billing for the period starting ${periodStart.slice(0, 10)}.`,
      confidence: 0.95,
      amountCents: priceCents,
      companyName,
      relatedId: cycleId,
      payload: { cycleId, subscriptionId, rateId, vatTreatment: "none" },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );

  if (result.status === "executed") {
    await advanceSubscription(sql, subscriptionId, window.end);
    return {
      outcome: `Billed ${companyName} ${formatZar(priceCents)} for the period from ${periodStart.slice(0, 10)}.`,
      executed: 1,
      escalated: 0,
      blocked: 0,
    };
  }
  if (result.status === "escalated") {
    return {
      outcome: `The ${companyName} invoice needs the founder: ${result.approvalId ?? "approval opened"}.`,
      executed: 0,
      escalated: 1,
      blocked: 0,
    };
  }
  return {
    outcome: `The ${companyName} invoice was not raised: ${result.error ?? result.status}.`,
    executed: 0,
    escalated: 0,
    blocked: 1,
  };
};

async function advanceSubscription(
  sql: Awaited<ReturnType<typeof getSql>>,
  subscriptionId: string,
  nextBillingAt: string,
): Promise<void> {
  await sql`
    update subscriptions
    set next_billing_at = ${nextBillingAt}, updated_at = now()
    where id = ${subscriptionId}
  `;
}

/**
 * Produce the deliverable for a billing period.
 *
 * The report is assembled by the office from its own records and written down
 * as a document. The agent never writes it.
 */
const fulfilServiceCycle: Runner = async (item) => {
  const sql = await getSql();
  const cycleId = str(item.payload.cycleId);
  const companyName = str(item.payload.companyName);
  const planId = str(item.payload.planId);
  const periodStart = str(item.payload.periodStart);
  const periodEnd = str(item.payload.periodEnd);
  const plan = planById(planId);
  if (!plan || !cycleId) {
    return noop(`No productised service is called "${planId}", so nothing was delivered.`);
  }

  const facts = await collectServiceFacts(sql, {
    companyName,
    periodStart,
    periodEnd,
    plan,
  });
  const report = buildServiceReport(plan, facts);
  const result = await applyProposedAction(
    "desk",
    {
      kind: "fulfil_service",
      title: `${plan.title} · ${companyName} · ${periodStart.slice(0, 10)}`,
      rationale: summariseService(plan, facts),
      confidence: 0.94,
      amountCents: 0,
      companyName,
      relatedId: cycleId,
      payload: { cycleId, planId, reportBody: report },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  if (result.status === "executed") {
    if (plan.cycle === "once") {
      await sql`
        update subscriptions
        set status = 'completed', updated_at = now()
        where id = ${str(item.payload.subscriptionId)} and status = 'active'
      `;
    }
    return {
      outcome: `Delivered the ${plan.title} to ${companyName}. ${summariseService(plan, facts)}`,
      executed: 1,
      escalated: 0,
      blocked: 0,
    };
  }
  return {
    outcome: `The ${plan.title} for ${companyName} was not delivered: ${result.status}.`,
    executed: 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/** Send the customer their report and their invoice. */
const sendServiceNotice: Runner = async (item) => {
  const sql = await getSql();
  const cycleId = str(item.payload.cycleId);
  const companyName = str(item.payload.companyName);
  const result = await applyProposedAction(
    "desk",
    {
      kind: "send_customer_mail",
      title: `Service report and invoice · ${companyName}`,
      rationale: `The ${str(item.payload.planId)} deliverable for this period is ready and the customer has not been told.`,
      confidence: 0.93,
      amountCents: 0,
      companyName,
      relatedId: cycleId,
      payload: {
        template: "service_report",
        cycleId,
        subscriptionId: str(item.payload.subscriptionId),
        planId: str(item.payload.planId),
      },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  if (result.status !== "executed") {
    return {
      outcome:
        `The ${companyName} notice was not sent: ${result.status}. ${result.error ?? ""}`.trim(),
      executed: 0,
      escalated: result.status === "escalated" ? 1 : 0,
      blocked: result.status === "blocked" ? 1 : 0,
    };
  }
  // The office never claims to have emailed a customer it did not email. A
  // failed delivery leaves the cycle fulfilled so the notice duty retries it,
  // and records the attempt time so that retry waits instead of hammering the
  // mail server on every tick.
  if (result.delivery?.ok) {
    await sql`
      update billing_cycles
      set status = case when status = 'fulfilled' then 'notified' else status end,
          notified_at = now(),
          notice_document_id = ${result.documentId ?? null},
          last_notice_attempt_at = now()
      where id = ${cycleId}
    `;
    return {
      outcome: `Sent ${companyName} their report and invoice.`,
      executed: 1,
      escalated: 0,
      blocked: 0,
    };
  }
  await sql`
    update billing_cycles
    set notice_document_id = ${result.documentId ?? null},
        last_notice_attempt_at = now()
    where id = ${cycleId}
  `;
  return {
    outcome: `Prepared the ${companyName} notice and wrote it down, but the message was not sent: ${result.delivery?.detail ?? "the mail server refused it"}. The customer was not emailed.`,
    executed: 1,
    escalated: 0,
    blocked: 0,
  };
};

/** Remind a customer about an invoice they have not paid. */
const sendPaymentReminder: Runner = async (item) => {
  const invoiceId = str(item.payload.invoiceId);
  const counterparty = str(item.payload.counterparty);
  const result = await applyProposedAction(
    "ledger",
    {
      kind: "send_customer_mail",
      title: `Payment reminder · ${counterparty}`,
      rationale: `The invoice has been open for more than a week and the customer has not been reminded.`,
      confidence: 0.92,
      amountCents: 0,
      companyName: counterparty,
      relatedId: invoiceId,
      payload: { template: "payment_reminder", invoiceId },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  if (result.status !== "executed") {
    return {
      outcome: `The reminder to ${counterparty} was not sent: ${result.status}.`,
      executed: 0,
      escalated: result.status === "escalated" ? 1 : 0,
      blocked: result.status === "blocked" ? 1 : 0,
    };
  }
  return {
    outcome: result.delivery?.ok
      ? `Reminded ${counterparty} about an open invoice.`
      : `Prepared the reminder to ${counterparty} and wrote it down, but the message was not sent: ${result.delivery?.detail ?? "the mail server refused it"}. The customer was not emailed.`,
    executed: 1,
    escalated: 0,
    blocked: 0,
  };
};

/** Send a customer the quote they are waiting on. */
const sendQuoteNotice: Runner = async (item) => {
  const documentId = str(item.payload.documentId);
  const sql = await getSql();
  const quote = await sql<{ title: string; summary: string; company_name: string }>`
    select d.title, d.summary, o.company_name
    from documents d
    left join opportunities o on o.id = d.related_id
    where d.id = ${documentId} and d.kind = 'quote'
  `.then((rows) => rows[0]);
  if (!quote) return noop("That quote is no longer on file.");
  const result = await applyProposedAction(
    "close",
    {
      kind: "send_customer_mail",
      title: `Quote · ${quote.company_name ?? "customer"}`,
      rationale: "A quote is approved and the customer has not received it.",
      confidence: 0.91,
      amountCents: 0,
      companyName: quote.company_name ?? "",
      relatedId: documentId,
      payload: { template: "quote", quoteDocumentId: documentId },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  if (result.status !== "executed") {
    return {
      outcome: `The quote was not sent: ${result.status}.`,
      executed: 0,
      escalated: result.status === "escalated" ? 1 : 0,
      blocked: result.status === "blocked" ? 1 : 0,
    };
  }
  return {
    outcome: result.delivery?.ok
      ? `Sent the quote to ${quote.company_name ?? "the customer"}.`
      : `Prepared the quote for ${quote.company_name ?? "the customer"} and wrote it down, but the message was not sent: ${result.delivery?.detail ?? "the mail server refused it"}. The customer was not emailed.`,
    executed: 1,
    escalated: 0,
    blocked: 0,
  };
};

/**
 * Start the subscription a customer bought.
 *
 * The first period was the quote they accepted and paid for. The
 * subscription starts the period after that, so nobody is billed twice for
 * the same month.
 */
const startSubscriptionCycle: Runner = async (item) => {
  const sql = await getSql();
  const opportunityId = str(item.payload.opportunityId);
  const companyName = str(item.payload.companyName);
  const planId = str(item.payload.planId);
  const rateId = str(item.payload.rateId);
  const cycle = str(item.payload.cycle, "monthly");
  const priceCents = intOf(item.payload.priceCents);
  const quoteDocumentId = str(item.payload.quoteDocumentId);
  const quote = quoteDocumentId
    ? await sql<{ accepted_at: string | Date | null; created_at: string | Date }>`
        select accepted_at, created_at from documents
        where id = ${quoteDocumentId} and kind = 'quote'
      `.then((rows) => rows[0])
    : undefined;
  // The driver may hand back either a Date or an ISO string. `String(date)`
  // drops milliseconds, which is enough to make the billing instant disagree
  // with the acceptance instant by part of a second.
  const acceptance = quote?.accepted_at ?? quote?.created_at;
  const acceptedAt =
    acceptance instanceof Date
      ? acceptance.toISOString()
      : acceptance
        ? new Date(acceptance).toISOString()
        : new Date().toISOString();
  const plan = planById(planId);
  if (!plan) return noop(`No productised service is called "${planId}".`);
  if (priceCents !== plan.priceCents) {
    return noop(
      `The ${plan.title} price on the quote does not match the published price, so no subscription was started.`,
    );
  }
  const firstPeriodEnd = nextCycleStart(acceptedAt, cycle as never);
  const { email, name } = await resolveRecipient(sql, companyName);
  const result = await applyProposedAction(
    "ledger",
    {
      kind: "start_subscription",
      title: `Subscription · ${companyName} · ${plan.title}`,
      rationale: `The customer accepted the ${plan.title} quote, so the plan now recurs from ${firstPeriodEnd.slice(0, 10)}.`,
      confidence: 0.94,
      amountCents: 0,
      companyName,
      relatedId: opportunityId,
      payload: {
        planId,
        rateId,
        cycle,
        priceCents,
        periodStart: firstPeriodEnd,
        opportunityId,
        quoteDocumentId: str(item.payload.quoteDocumentId) || null,
        contactEmail: email ?? null,
        contactName: name ?? null,
      },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  return {
    outcome:
      result.status === "executed"
        ? `Started the ${plan.title} for ${companyName}, billing from ${firstPeriodEnd.slice(0, 10)}.`
        : `The ${plan.title} subscription for ${companyName} was not started: ${result.status}.`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/** Open a sales opportunity from a qualified lead that came in through a real channel. */
const openSalesOpportunity: Runner = async (item) => {
  const leadId = str(item.payload.leadId);
  const companyName = str(item.payload.companyName);
  const sql = await getSql();
  const lead = await sql<{ stage: string; inbound_id: string | null }>`
    select stage, inbound_id from leads where id = ${leadId}
  `.then((rows) => rows[0]);
  if (!lead) return noop("That lead is no longer on file.");
  if (lead.stage !== "qualified" || !lead.inbound_id) {
    return noop("The lead is not qualified from a real enquiry, so no opportunity was opened.");
  }
  const result = await applyProposedAction(
    "close",
    {
      kind: "open_opportunity",
      title: `Opportunity · ${companyName}`,
      rationale: `${item.reason} A real enquiry and a qualified lead are on file.`,
      confidence: 0.94,
      amountCents: 0,
      companyName,
      relatedId: leadId,
      payload: { score: intOf(item.payload.score) },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  return {
    outcome:
      result.status === "executed"
        ? `Opened a sales opportunity for ${companyName}.`
        : `The ${companyName} opportunity was not opened: ${result.status}.`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/** Put a published-rate quote on a real discovery. */
const issueQuote: Runner = async (item) => {
  const sql = await getSql();
  const opportunityId = str(item.payload.opportunityId);
  const companyName = str(item.payload.companyName);
  const amountCents = intOf(item.payload.amountCents);
  const rateId = str(item.payload.rateId);
  const location = str(item.payload.location, "remote");
  const quantity = Number(item.payload.quantity);
  if (!opportunityId || !rateId || amountCents <= 0 || !Number.isFinite(quantity)) {
    return noop("The quote work item is missing its opportunity, rate or amount.");
  }
  const state = await sql<{ stage: string; quote_count: number }>`
    select o.stage,
           (select count(*)::int from documents d
            where d.kind = 'quote' and d.related_id = o.id) as quote_count
    from opportunities o where o.id = ${opportunityId}
  `.then((rows) => rows[0]);
  if (!state) return noop("That opportunity is no longer on file.");
  if (state.stage !== "discovery") return noop("The opportunity has already moved past discovery.");
  if (Number(state.quote_count) > 0) return noop("That opportunity already has a quote.");
  const result = await applyProposedAction(
    "close",
    {
      kind: "issue_quote",
      title: `Quote · ${companyName}`,
      rationale: `${item.reason} Every line is published and the customer has not been promised an outcome.`,
      confidence: 0.93,
      amountCents,
      companyName,
      relatedId: opportunityId,
      payload: {
        rateId,
        location,
        quantity,
        scope: Array.isArray(item.payload.scope) ? item.payload.scope : [],
      },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  return {
    outcome:
      result.status === "executed"
        ? `Issued a published-rate quote to ${companyName}. It is waiting on the quote notice.`
        : `The ${companyName} quote was not issued: ${result.status}. ${result.error ?? ""}`.trim(),
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/** Raise the invoice for won work that has an accepted quote. */
const issueWonInvoice: Runner = async (item) => {
  const sql = await getSql();
  const opportunityId = str(item.payload.opportunityId);
  const companyName = str(item.payload.companyName);
  const valueCents = intOf(item.payload.valueCents);
  if (!opportunityId || valueCents <= 0)
    return noop("The invoice work item has no opportunity value.");
  const record = await sql<{
    stage: string;
    accepted: number;
    invoiced: number;
    quote_amount_cents: number | null;
  }>`
    select o.stage,
           (select count(*)::int from documents d
            where d.kind = 'quote' and d.status = 'accepted' and d.related_id = o.id) as accepted,
           (select count(*)::int from ledger_entries l
            where l.kind = 'invoice' and l.related_id = o.id) as invoiced,
           (select d.amount_cents from documents d
            where d.kind = 'quote' and d.status = 'accepted' and d.related_id = o.id
            order by coalesce(d.accepted_at, d.created_at) desc limit 1) as quote_amount_cents
    from opportunities o where o.id = ${opportunityId}
  `.then((rows) => rows[0]);
  if (!record) return noop("That opportunity is no longer on file.");
  if (record.stage !== "won") return noop("The opportunity is not won, so no invoice was raised.");
  if (Number(record.accepted) === 0) return noop("There is no accepted quote for this work.");
  if (Number(record.invoiced) > 0) return noop("This work already has an invoice.");
  // The accepted quote is the authority for the figure. The opportunity value is
  // only a fallback for quotes written before amounts were snapshotted.
  const invoiceCents = Number(record.quote_amount_cents ?? 0) || valueCents;
  const result = await applyProposedAction(
    "ledger",
    {
      kind: "issue_invoice",
      title: `Invoice · ${companyName}`,
      rationale: `${item.reason} The invoice is for the accepted quote figure.`,
      confidence: 0.95,
      amountCents: invoiceCents,
      companyName,
      relatedId: opportunityId,
      payload: { vatTreatment: "none" },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  return {
    outcome:
      result.status === "executed"
        ? `Raised the ${companyName} invoice for ${formatZar(invoiceCents)}.`
        : `The ${companyName} invoice was not raised: ${result.status}. ${result.error ?? ""}`.trim(),
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

/** Email the customer the invoice the office has just raised. */
const sendInvoiceNotice: Runner = async (item) => {
  const invoiceId = str(item.payload.invoiceId);
  const companyName = str(item.payload.companyName);
  const result = await applyProposedAction(
    "ledger",
    {
      kind: "send_customer_mail",
      title: `Invoice · ${companyName}`,
      rationale: "The invoice is on file and the customer has not been sent it.",
      confidence: 0.94,
      amountCents: 0,
      companyName,
      relatedId: invoiceId,
      payload: { template: "invoice", invoiceId },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  if (result.status !== "executed") {
    return {
      outcome: `The invoice notice to ${companyName} was not sent: ${result.status}.`,
      executed: 0,
      escalated: result.status === "escalated" ? 1 : 0,
      blocked: result.status === "blocked" ? 1 : 0,
    };
  }
  return {
    outcome: result.delivery?.ok
      ? `Sent ${companyName} their invoice.`
      : `Prepared the ${companyName} invoice notice and wrote it down, but the message was not sent: ${result.delivery?.detail ?? "the mail server refused it"}.`,
    executed: 1,
    escalated: 0,
    blocked: 0,
  };
};

/** Acknowledge a cleared receipt. */
const sendReceiptNotice: Runner = async (item) => {
  const receiptId = str(item.payload.receiptId);
  const invoiceId = str(item.payload.invoiceId);
  const companyName = str(item.payload.companyName);
  const result = await applyProposedAction(
    "ledger",
    {
      kind: "send_customer_mail",
      title: `Receipt · ${companyName}`,
      rationale: "The payment has been matched and the customer has not been sent a receipt.",
      confidence: 0.95,
      amountCents: 0,
      companyName,
      relatedId: receiptId,
      payload: { template: "receipt", receiptId, invoiceId },
    },
    { source: "scheduler", workItem: item.id, autonomous: true },
  );
  if (result.status !== "executed") {
    return {
      outcome: `The receipt notice to ${companyName} was not sent: ${result.status}.`,
      executed: 0,
      escalated: result.status === "escalated" ? 1 : 0,
      blocked: result.status === "blocked" ? 1 : 0,
    };
  }
  return {
    outcome: result.delivery?.ok
      ? `Sent ${companyName} their receipt.`
      : `Prepared the ${companyName} receipt and wrote it down, but the message was not sent: ${result.delivery?.detail ?? "the mail server refused it"}.`,
    executed: 1,
    escalated: 0,
    blocked: 0,
  };
};

/** The weekly look at the recurring-revenue book. */
const reviewSubscriptionHealth: Runner = async (item) => {
  const result = await applyProposedAction(
    "keep",
    {
      kind: "notify_operator",
      title: "Recurring revenue review",
      rationale: item.reason,
      confidence: 0.9,
      amountCents: 0,
      payload: {
        stale: Array.isArray(item.payload.stale) ? item.payload.stale : [],
        rateCardOk: item.payload.rateCardOk === true,
        rateCardDetail: str(item.payload.rateCardDetail),
      },
    },
    { source: "scheduler", workItem: item.id },
  );
  return {
    outcome: `Recurring revenue reviewed: ${result.status}`,
    executed: result.status === "executed" ? 1 : 0,
    escalated: result.status === "escalated" ? 1 : 0,
    blocked: result.status === "blocked" ? 1 : 0,
  };
};

// ── Registry ──────────────────────────────────────────────────────────────────

export const RUNNERS: Record<string, Runner> = {
  report_silent_agent: reportSilentAgent,
  watch_cloudflare_token: watchCloudflareToken,
  report_stuck_backlog: reportStuckBacklog,
  report_abandoned_work: reportAbandonedWork,
  report_daily_briefing: reportDailyBriefing,
  route_inbound: routeInbound,
  classify_inbound: classifyInbound,
  escalate_stale_enquiry: escalateStaleEnquiry,
  analyse_site_signals: analyseSiteSignals,
  write_content_brief: writeContentBrief,
  qualify_lead: qualifyLead,
  propose_sales_handoff: proposeSalesHandoff,
  prospect_from_site_signals: prospectFromSiteSignals,
  draft_campaign: draftCampaign,
  advance_discovery: advanceDiscovery,
  open_sales_opportunity: openSalesOpportunity,
  issue_quote: issueQuote,
  draft_quote_followup: draftQuoteFollowUp,
  review_cold_proposal: reviewColdProposal,
  nudge_invoice: nudgeInvoice,
  acknowledge_ticket: acknowledgeTicket,
  escalate_ageing_ticket: escalateAgeingTicket,
  draft_chat_reply: draftChatReply,
  diagnose_ticket: diagnoseTicket,
  record_knowledge: recordKnowledge,
  draft_invoice_chase: draftInvoiceChase,
  verify_payment_notice: verifyPaymentNotice,
  report_payables: reportPayables,
  file_missing_records: fileMissingRecords,
  halt_broken_chain: haltBrokenChain,
  report_scope_drift: reportScopeDrift,
  anchor_chain_head: anchorChainHead,
  bill_subscription_cycle: billSubscriptionCycle,
  issue_won_invoice: issueWonInvoice,
  send_invoice_notice: sendInvoiceNotice,
  send_receipt_notice: sendReceiptNotice,
  fulfil_service_cycle: fulfilServiceCycle,
  send_service_notice: sendServiceNotice,
  send_payment_reminder: sendPaymentReminder,
  send_quote_notice: sendQuoteNotice,
  review_subscription_health: reviewSubscriptionHealth,
  start_subscription_cycle: startSubscriptionCycle,
};

async function resolveCompany(relatedId: string | null): Promise<string> {
  if (!relatedId) return "the customer";
  const sql = await getSql();
  const row = await sql<{ company_name: string }>`
    select company_name from opportunities where id = ${relatedId}
  `.then((rows) => rows[0]);
  return row?.company_name ?? "the customer";
}

async function sendFounderAlert(title: string, detail: string, where?: string): Promise<void> {
  try {
    const { deliverFounderNotice } = await import("./notify.server");
    const { founderOfficeAlertNotice } = await import("./notice");
    await deliverFounderNotice(founderOfficeAlertNotice({ title, detail, where }));
  } catch {
    // Already recorded in the audit trail; the office screen is the backstop.
  }
}

export { heartbeat, sendCustomerMail, applyProposedAction, fileDocument, str, intOf };
export type { PlannedWork };
