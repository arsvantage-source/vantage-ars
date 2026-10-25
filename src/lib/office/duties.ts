/**
 * Autonomous duties — the pure planning half.
 *
 * Each duty answers one question about the *real* state of the office and
 * returns work items, or nothing. No duty may invent a customer, a figure, or a
 * record: everything here is derived from rows that already exist, which is why
 * this module is a pure function of its input and is exhaustively unit-tested.
 *
 * A duty returning an empty list is a healthy, successful run. "Nothing needed
 * doing" is the correct answer most of the time, and the office must be able to
 * say so honestly rather than manufacture activity to look busy.
 */
import { PUBLISHED_RATES } from "./catalogue";
import { planForRate } from "./plans";
import { chooseQuote, quoteScopeLines, type QuoteChoice } from "./quote-playbook";

const HOUR = 60;
const DAY = 24 * HOUR;

export type PlannedWork = {
  agentId: string;
  kind: string;
  reason: string;
  priority: number;
  payload?: Record<string, unknown>;
  /** One open item per (duty, subject). Omit only for genuinely one-shot work. */
  dedupeKey: string;
  /** Overrides the default of 3 attempts for duties that must not retry. */
  maxAttempts?: number;
};

export type InboundView = {
  id: string;
  channel: string;
  companyName: string;
  subject: string;
  summary: string;
  intent: string;
  status: string;
  createdAt: string;
};

export type LeadView = {
  id: string;
  companyName: string;
  stage: string;
  score: number;
  summary: string;
  inboundId: string | null;
  updatedAt: string;
};

export type OpportunityView = {
  id: string;
  companyName: string;
  stage: string;
  valueCents: number;
  summary: string;
  updatedAt: string;
};

export type QuoteView = {
  id: string;
  title: string;
  kind: string;
  status: string;
  relatedId: string | null;
  createdAt: string;
  /** The published rate line the quote came from, when it is known. */
  rateId?: string | null;
  /** The figure the customer was quoted, snapshotted when the quote was written. */
  amountCents?: number;
  acceptedAt?: string | null;
};

export type TicketView = {
  id: string;
  title: string;
  severity: string;
  status: string;
  ownerAgent: string;
  summary: string;
  relatedId: string | null;
  updatedAt: string;
};

export type LedgerView = {
  id: string;
  kind: string;
  counterparty: string;
  amountCents: number;
  status: string;
  relatedId: string | null;
  createdAt: string;
};

export type DocumentView = {
  id: string;
  title: string;
  kind: string;
  status: string;
  relatedId: string | null;
  createdAt: string;
};

export type NoticeView = {
  id: string;
  template: string;
  status: string;
  relatedId: string | null;
  companyName: string | null;
  createdAt: string;
};

export type CampaignView = {
  id: string;
  name: string;
  channel: string;
  status: string;
  budgetCents: number;
  spendCents: number;
  summary: string;
  createdAt: string;
};

export type AgentView = {
  id: string;
  callsign: string;
  status: string;
  lastHeartbeat: string | null;
};

export type SiteEventView = { kind: string; path: string; occurredAt: string };

export type ChatThreadView = {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  lastMessageAt: string | null;
  unansweredCount: number;
};

export type QuoteLinkView = {
  documentId: string;
  state: string;
  viewCount: number;
  createdAt: string;
  lastViewedAt: string | null;
};

export type SubscriptionView = {
  id: string;
  companyName: string;
  planId: string;
  rateId: string;
  cycle: string;
  priceCents: number;
  status: string;
  nextBillingAt: string;
  startedAt: string;
  contactEmail: string | null;
};

export type BillingCycleView = {
  id: string;
  subscriptionId: string;
  companyName: string;
  planId: string;
  amountCents: number;
  status: string;
  periodStart: string;
  periodEnd: string;
  invoiceId: string | null;
  documentId: string | null;
  reportDocumentId: string | null;
  notifiedAt: string | null;
  lastNoticeAttemptAt?: string | null;
};

export type DelegationView = {
  id: string;
  label: string;
  status: string;
  maxAmountCents: number;
  maxActionsPerDay: number;
  maxActionsPerMonth: number;
  allowedActions: string[];
  allowedRateIds: string[];
  allowCustomerMail: boolean;
  allowAutoReconcile: boolean;
  requireAcceptedQuote: boolean;
};

export type DutyView = {
  now: string;
  halted: boolean;
  inbound: InboundView[];
  leads: LeadView[];
  opportunities: OpportunityView[];
  quotes: QuoteView[];
  tickets: TicketView[];
  ledger: LedgerView[];
  documents: DocumentView[];
  notices: NoticeView[];
  campaigns: CampaignView[];
  approvalsPending: {
    id: string;
    kind: string;
    title: string;
    companyName: string | null;
    createdAt: string;
  }[];
  agents: AgentView[];
  siteEvents: SiteEventView[];
  chatThreads: ChatThreadView[];
  quoteLinks: QuoteLinkView[];
  subscriptions: SubscriptionView[];
  billingCycles: BillingCycleView[];
  delegation: DelegationView | null;
  treasuryCents: number;
  receivableCents: number;
  payableCents: number;
  publishedPathCount: number;
  chainIntact: boolean;
  /** Work the queue already knows about; the orchestrator's view of the backlog. */
  work: WorkQueueView[];
};

export type WorkQueueView = {
  id: string;
  agentId: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  dueAt: string;
  lastError: string | null;
};

export type DutyId =
  | "vantage_liveness"
  | "vantage_backlog"
  | "vantage_briefing"
  | "foyer_intake"
  | "foyer_stale_intake"
  | "signal_site_signals"
  | "signal_content_brief"
  | "signal_draft_campaign"
  | "signal_prospect"
  | "signal_qualify_leads"
  | "signal_handoff"
  | "close_discovery"
  | "close_quote"
  | "close_quote_followup"
  | "close_stale_proposal"
  | "close_win_handoff"
  | "desk_acknowledge"
  | "desk_sla_watch"
  | "desk_chat_reply"
  | "forge_diagnose"
  | "forge_knowledge"
  | "ledger_chase_invoice"
  | "ledger_payment_notices"
  | "ledger_payables"
  | "keep_records"
  | "seal_chain_verify"
  | "seal_scope_audit"
  | "seal_chain_anchor"
  | "ledger_subscription_billing"
  | "ledger_dunning"
  | "ledger_billing"
  | "desk_service_fulfilment"
  | "desk_service_notice"
  | "close_quote_notice"
  | "ledger_start_subscription"
  | "keep_subscription_review"
  | "key_token_watch";

export const DUTY_CADENCE_MINUTES: Record<DutyId, number> = {
  vantage_liveness: 30,
  vantage_backlog: 60,
  vantage_briefing: 1440,
  foyer_intake: 10,
  foyer_stale_intake: 60,
  signal_site_signals: 720,
  signal_content_brief: 1440,
  signal_draft_campaign: 10080,
  signal_prospect: 1440,
  signal_qualify_leads: 180,
  signal_handoff: 120,
  close_discovery: 240,
  close_quote: 60,
  close_quote_followup: 720,
  close_stale_proposal: 1440,
  close_win_handoff: 60,
  desk_acknowledge: 30,
  desk_sla_watch: 120,
  desk_chat_reply: 15,
  forge_diagnose: 30,
  forge_knowledge: 1440,
  ledger_chase_invoice: 1440,
  ledger_payment_notices: 120,
  ledger_payables: 1440,
  keep_records: 720,
  seal_chain_verify: 720,
  seal_scope_audit: 1440,
  seal_chain_anchor: 1440,
  ledger_subscription_billing: 60,
  ledger_dunning: 240,
  ledger_billing: 30,
  desk_service_fulfilment: 60,
  desk_service_notice: 60,
  close_quote_notice: 120,
  ledger_start_subscription: 240,
  keep_subscription_review: 10080,
  key_token_watch: 720,
};

export const DUTY_OWNER: Record<DutyId, string> = {
  vantage_liveness: "vantage",
  vantage_backlog: "vantage",
  vantage_briefing: "vantage",
  foyer_intake: "foyer",
  foyer_stale_intake: "foyer",
  signal_site_signals: "signal",
  signal_content_brief: "signal",
  signal_draft_campaign: "signal",
  signal_prospect: "signal",
  signal_qualify_leads: "signal",
  signal_handoff: "signal",
  close_discovery: "close",
  close_quote: "close",
  close_quote_followup: "close",
  close_stale_proposal: "close",
  close_win_handoff: "close",
  desk_acknowledge: "desk",
  desk_sla_watch: "desk",
  desk_chat_reply: "desk",
  forge_diagnose: "forge",
  forge_knowledge: "forge",
  ledger_chase_invoice: "ledger",
  ledger_payment_notices: "ledger",
  ledger_payables: "ledger",
  keep_records: "keep",
  seal_chain_verify: "seal",
  seal_scope_audit: "seal",
  seal_chain_anchor: "seal",
  ledger_subscription_billing: "ledger",
  ledger_dunning: "ledger",
  ledger_billing: "ledger",
  desk_service_fulfilment: "desk",
  desk_service_notice: "desk",
  close_quote_notice: "close",
  ledger_start_subscription: "ledger",
  keep_subscription_review: "keep",
  key_token_watch: "key",
};

export const DUTY_TITLES: Record<DutyId, string> = {
  vantage_liveness: "Check the floor is alive",
  vantage_backlog: "Report a blocked backlog",
  vantage_briefing: "Brief the founder daily",
  foyer_intake: "Intake and classify new enquiries",
  foyer_stale_intake: "Chase enquiries nobody picked up",
  signal_site_signals: "Read real site signals",
  signal_content_brief: "Brief the next owned-site piece",
  signal_draft_campaign: "Draft this week's campaign",
  signal_prospect: "Prospect from site signals",
  signal_qualify_leads: "Score and qualify leads",
  signal_handoff: "Hand qualified demand to sales",
  close_discovery: "Open and advance sales work",
  close_quote: "Quote qualified demand",
  close_quote_followup: "Follow up on quotes",
  close_stale_proposal: "Review cold proposals",
  close_win_handoff: "Hand won work to delivery",
  desk_acknowledge: "Acknowledge service requests",
  desk_sla_watch: "Watch ageing service tickets",
  desk_chat_reply: "Draft replies to waiting chats",
  forge_diagnose: "Write a technical procedure",
  forge_knowledge: "Turn resolved faults into knowledge",
  ledger_chase_invoice: "Chase overdue invoices",
  ledger_payment_notices: "Reconcile payment notices",
  ledger_payables: "Review payables",
  keep_records: "Check the filing is complete",
  seal_chain_verify: "Verify the audit chain",
  seal_scope_audit: "Audit agents against their roles",
  seal_chain_anchor: "Anchor the audit chain head",
  ledger_subscription_billing: "Bill the subscriptions that are due",
  ledger_dunning: "Chase overdue invoices",
  ledger_billing: "Invoice won work and send the paperwork",
  desk_service_fulfilment: "Deliver the productised services",
  desk_service_notice: "Send the customer their report and invoice",
  close_quote_notice: "Send the customer their quote",
  ledger_start_subscription: "Start the subscriptions that were sold",
  keep_subscription_review: "Review the recurring-revenue book",
  key_token_watch: "Check the Cloudflare token",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function ageMinutes(iso: string, now: string): number {
  const then = Date.parse(iso);
  const current = Date.parse(now);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.round((current - then) / 60_000));
}

/** Whether a live delegation covers one action. */
function delegated(view: DutyView, action: string): boolean {
  const policy = view.delegation;
  return Boolean(policy && policy.status === "active" && policy.allowedActions.includes(action));
}

/** Whether the customer actually contacted the office. */
function hasRealEnquiry(view: DutyView, companyName: string): boolean {
  const key = companyName.trim().toLowerCase();
  if (!key) return false;
  return view.inbound.some((item) => item.companyName.trim().toLowerCase() === key);
}

/** Whether an email address is already on file for the customer. */
function hasRecipient(view: DutyView, companyName: string): boolean {
  const key = companyName.trim().toLowerCase();
  if (!key) return false;
  if (
    view.subscriptions.some(
      (sub) => sub.companyName.trim().toLowerCase() === key && sub.contactEmail,
    )
  ) {
    return true;
  }
  return [...view.inbound, ...view.leads]
    .filter((row) => row.companyName.trim().toLowerCase() === key)
    .some((row) => /Email:\s*[^\s,;]+@[^\s,;]+/i.test(row.summary));
}

/** The published line the office may quote for this opportunity, if any. */
function autoQuoteFor(view: DutyView, opp: DutyView["opportunities"][number]): QuoteChoice | null {
  if (!delegated(view, "issue_quote") || !hasRealEnquiry(view, opp.companyName)) return null;
  const choice = chooseQuote({ companyName: opp.companyName, summary: opp.summary });
  if (!choice) return null;
  const policy = view.delegation;
  if (!policy) return null;
  if (!policy.allowedRateIds.includes(choice.rateId)) return null;
  if (choice.amountCents > policy.maxAmountCents) return null;
  return choice;
}

/** Words that signal the sender actually wants to buy something. */
const DEMAND_SIGNALS = [
  "quote",
  "pricing",
  "price",
  "cost",
  "how much",
  "rate",
  "rates",
  "proposal",
  "interested",
  "looking for",
  "need help",
  "we need",
  "upgrade",
  "install",
  "installation",
  "setup",
  "migrate",
  "migration",
  "consult",
  "appointment",
  "available",
  "would like",
  "can you",
  "help with",
];

const SUPPORT_SIGNALS = [
  "not working",
  "broken",
  "down",
  "fault",
  "issue",
  "problem",
  "can't",
  "cannot",
  "won't",
  "outage",
  "no internet",
  "no dial",
  "dropping",
  "intermittent",
  "help",
  "urgent",
  "asap",
];

const SPAM_SIGNALS = [
  "seo services",
  "backlinks",
  "guest post",
  "crypto",
  "casino",
  "viagra",
  "web design",
  "we can help you get more leads",
  "dear sir or madam",
  "unsubscribe",
];

/** Deterministic, explainable lead scoring. Returns points and the reasons. */
export function scoreLead(
  text: string,
  from: string,
): { score: number; reasons: string[]; demand: number; support: number; spam: boolean } {
  const haystack = `${text} ${from}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const spam = SPAM_SIGNALS.filter((needle) => haystack.includes(needle));
  if (spam.length) {
    return {
      score: -100,
      reasons: [`Reads as unsolicited outreach: ${spam.join(", ")}`],
      demand: 0,
      support: 0,
      spam: true,
    };
  }

  const demand = DEMAND_SIGNALS.filter((needle) => haystack.includes(needle));
  const support = SUPPORT_SIGNALS.filter((needle) => haystack.includes(needle));
  score += Math.min(40, demand.length * 10);
  score += Math.min(30, support.length * 8);
  if (demand.length) reasons.push(`Asks about buying: ${demand.slice(0, 4).join(", ")}`);
  if (support.length)
    reasons.push(`Reports a fault or need help: ${support.slice(0, 4).join(", ")}`);

  const length = text.trim().length;
  if (length >= 120) {
    score += 15;
    reasons.push("Gave real detail about their situation.");
  } else if (length < 40) {
    score -= 10;
    reasons.push("Very little detail.");
  }

  if (/\b(urgent|asap|down|outage|can't work|no service)\b/i.test(haystack)) {
    score += 15;
    reasons.push("Says the problem is stopping work.");
  }
  if (/[\d]{3,}/.test(haystack)) {
    score += 5;
    reasons.push("Named a device count, budget, or extension number.");
  }
  if (/\b(we|our|company|office|team|staff)\b/i.test(haystack)) {
    score += 10;
    reasons.push("Sounds like an organisation rather than a one-off.");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    demand: demand.length,
    support: support.length,
    spam: false,
  };
}

// ── Duties ────────────────────────────────────────────────────────────────────

/**
 * Plan one duty. Returns the work it wants done; an empty array means the office
 * is in good shape for that responsibility.
 */
export function planDuty(duty: DutyId, view: DutyView): PlannedWork[] {
  if (view.halted) return [];
  switch (duty) {
    case "vantage_liveness":
      return planLiveness(view);
    case "vantage_backlog":
      return planBacklog(view);
    case "vantage_briefing":
      return planBriefing(view);
    case "foyer_intake":
      return planFoyerIntake(view);
    case "foyer_stale_intake":
      return planFoyerStaleIntake(view);
    case "signal_site_signals":
      return planSiteSignals(view);
    case "signal_content_brief":
      return planContentBrief(view);
    case "signal_draft_campaign":
      return planDraftCampaign(view);
    case "signal_prospect":
      return planProspect(view);
    case "signal_qualify_leads":
      return planQualifyLeads(view);
    case "signal_handoff":
      return planHandoff(view);
    case "close_discovery":
      return planDiscovery(view);
    case "close_quote":
      return planCloseQuote(view);
    case "close_quote_followup":
      return planQuoteFollowUp(view);
    case "close_stale_proposal":
      return planStaleProposal(view);
    case "close_win_handoff":
      return planWinHandoff(view);
    case "desk_acknowledge":
      return planAcknowledge(view);
    case "desk_sla_watch":
      return planSlaWatch(view);
    case "desk_chat_reply":
      return planChatReply(view);
    case "forge_diagnose":
      return planDiagnose(view);
    case "forge_knowledge":
      return planKnowledge(view);
    case "ledger_chase_invoice":
      return planChaseInvoice(view);
    case "ledger_payment_notices":
      return planPaymentNotices(view);
    case "ledger_payables":
      return planPayables(view);
    case "keep_records":
      return planRecords(view);
    case "seal_chain_verify":
      return planChainVerify(view);
    case "seal_scope_audit":
      return planScopeAudit(view);
    case "seal_chain_anchor":
      return planChainAnchor(view);
    case "ledger_subscription_billing":
      return planSubscriptionBilling(view);
    case "ledger_dunning":
      return planDunning(view);
    case "ledger_billing":
      return planBilling(view);
    case "desk_service_fulfilment":
      return planServiceFulfilment(view);
    case "desk_service_notice":
      return planServiceNotice(view);
    case "close_quote_notice":
      return planQuoteNotice(view);
    case "ledger_start_subscription":
      return planStartSubscription(view);
    case "keep_subscription_review":
      return planSubscriptionReview(view);
    case "key_token_watch":
      return planTokenWatch(view);
    default:
      return [];
  }
}

/**
 * The orchestrator's own duty. The single most dangerous failure mode for an
 * office that runs unattended is a queue that silently stops draining — items
 * pile up and nothing says so. This surfaces both a stuck backlog and work that
 * has exhausted its retries.
 */
function planTokenWatch(view: DutyView): PlannedWork[] {
  return [
    {
      agentId: "key",
      kind: "watch_cloudflare_token",
      reason:
        "Confirm the Cloudflare token is set and accepted. The token value is not part of this work.",
      priority: 20,
      payload: {},
      dedupeKey: `cf-token:${view.now.slice(0, 10)}`,
    },
  ];
}

function planBacklog(view: DutyView): PlannedWork[] {
  const work: PlannedWork[] = [];
  const open = view.work.filter((item) => item.status === "open");
  const abandoned = view.work.filter((item) => item.status === "abandoned");

  // Anything overdue by more than twice the busiest cadence is stuck, not busy.
  const stuck = open.filter((item) => ageMinutes(item.dueAt, view.now) > 240);
  if (stuck.length >= 3) {
    work.push({
      agentId: "vantage",
      kind: "report_stuck_backlog",
      reason: `${stuck.length} work items have been waiting more than four hours: ${stuck
        .slice(0, 5)
        .map((i) => `${i.agentId}/${i.kind}`)
        .join(", ")}.`,
      priority: 9,
      payload: {
        stuck: stuck.slice(0, 20).map((item) => ({
          id: item.id,
          agentId: item.agentId,
          kind: item.kind,
          attempts: item.attempts,
        })),
      },
      dedupeKey: `stuck-backlog:${Math.floor(view.work.length / 5)}`,
    });
  }

  if (abandoned.length) {
    work.push({
      agentId: "vantage",
      kind: "report_abandoned_work",
      reason: `${abandoned.length} work item(s) exhausted their retries and were abandoned. Last error: ${abandoned[0].lastError ?? "unknown"}.`,
      priority: 7,
      payload: {
        abandoned: abandoned.slice(0, 20).map((item) => ({
          id: item.id,
          agentId: item.agentId,
          kind: item.kind,
          attempts: item.attempts,
          lastError: item.lastError,
        })),
      },
      dedupeKey: `abandoned:${new Date(view.now).toISOString().slice(0, 10)}`,
    });
  }

  return work;
}

/**
 * The orchestrator's daily briefing. An office that runs unattended owes the
 * founder one honest summary a day: what is on the books, what is waiting on a
 * decision, and whether the queue is clear. It only exists when there is real
 * state to describe — on an empty office it says nothing, because there is
 * nothing truthful to say.
 */
function planBriefing(view: DutyView): PlannedWork[] {
  const hasState =
    view.leads.length > 0 ||
    view.opportunities.length > 0 ||
    view.tickets.length > 0 ||
    view.inbound.length > 0 ||
    view.ledger.length > 0 ||
    view.documents.length > 0 ||
    view.campaigns.length > 0 ||
    view.chatThreads.length > 0 ||
    view.approvalsPending.length > 0 ||
    view.treasuryCents > 0 ||
    view.receivableCents > 0 ||
    view.payableCents > 0;
  if (!hasState) return [];
  const date = new Date(view.now).toISOString().slice(0, 10);
  return [
    {
      agentId: "vantage",
      kind: "report_daily_briefing",
      reason:
        "The office has real work on the books. One factual summary a day, from records only.",
      priority: 70,
      payload: { date },
      dedupeKey: `briefing:${date}`,
    },
  ];
}

function planLiveness(view: DutyView): PlannedWork[] {
  // An agent that has not recorded a heartbeat is only a problem when it HAS
  // work waiting. An agent with an empty queue and nothing due is idle, which is
  // the correct state for most of the day — reporting that as "silent" would
  // bury a real failure under noise the founder learns to ignore.
  const work: PlannedWork[] = [];
  const staleMinutes = 120;
  const outstanding = (agentId: string): number =>
    view.work.filter((item) => item.agentId === agentId && item.status !== "abandoned").length;

  for (const agent of view.agents) {
    const beat = agent.lastHeartbeat ? ageMinutes(agent.lastHeartbeat, view.now) : Infinity;
    if (beat <= staleMinutes) continue;

    const waiting = outstanding(agent.id);
    // Never heartbeat at all since the office was provisioned: that is a real
    // fault regardless of queue depth, because it means the agent has never run.
    const neverRan = agent.lastHeartbeat === null;
    if (waiting === 0 && !neverRan) continue;

    work.push({
      agentId: "vantage",
      kind: "report_silent_agent",
      reason: neverRan
        ? `${agent.callsign} has never run. Its first work item is ${waiting ? "still waiting" : "queued for the next tick"}.`
        : `${agent.callsign} has ${waiting} item(s) waiting and has not recorded work for ${beat} minutes.`,
      priority: neverRan ? 4 : 6,
      payload: { silentAgent: agent.id, waiting, minutes: Number.isFinite(beat) ? beat : null },
      dedupeKey: `liveness:${agent.id}:${Math.floor(beat / 60)}`,
    });
  }
  return work;
}

function planFoyerIntake(view: DutyView): PlannedWork[] {
  const handled = new Set<string>();
  for (const lead of view.leads) if (lead.inboundId) handled.add(lead.inboundId);
  for (const ticket of view.tickets) if (ticket.relatedId) handled.add(ticket.relatedId);
  return view.inbound
    .filter((item) => item.status === "received" && !handled.has(item.id))
    .map((item) => ({
      agentId: "foyer",
      kind: "classify_inbound",
      reason: `Classify and route: ${item.subject}`,
      priority: item.intent === "support" ? 20 : 15,
      payload: {
        inboundId: item.id,
        companyName: item.companyName,
        intent: item.intent,
        subject: item.subject,
        summary: item.summary,
        channel: item.channel,
      },
      dedupeKey: `intake:${item.id}`,
    }));
}

function planFoyerStaleIntake(view: DutyView): PlannedWork[] {
  const work: PlannedWork[] = [];
  for (const item of view.inbound) {
    if (item.status !== "received") continue;
    const age = ageMinutes(item.createdAt, view.now);
    if (age < 4 * HOUR) continue;
    work.push({
      agentId: "foyer",
      kind: "escalate_stale_enquiry",
      reason: `${item.companyName} wrote ${Math.floor(age / 60)}h ago about "${item.subject}" and nobody has answered.`,
      priority: 8,
      payload: {
        inboundId: item.id,
        companyName: item.companyName,
        ageHours: Math.floor(age / 60),
      },
      dedupeKey: `stale-intake:${item.id}:${Math.floor(age / (24 * HOUR))}`,
    });
  }
  return work;
}

function planSiteSignals(view: DutyView): PlannedWork[] {
  if (!view.siteEvents.length) return [];
  const byPath = new Map<string, number>();
  for (const event of view.siteEvents) {
    byPath.set(event.path, (byPath.get(event.path) ?? 0) + 1);
  }
  return [
    {
      agentId: "signal",
      kind: "analyse_site_signals",
      reason: `${view.siteEvents.length} real visits recorded. ${[...byPath.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([p, n]) => `${p} (${n})`)
        .join(", ")}`,
      priority: 40,
      payload: { paths: [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10) },
      dedupeKey: `site-signals:${view.siteEvents[view.siteEvents.length - 1]?.occurredAt.slice(0, 10) ?? "none"}`,
    },
  ];
}

function planContentBrief(view: DutyView): PlannedWork[] {
  // One brief per day, but only when there is a real gap to write about.
  const briefs = view.documents.filter((doc) => doc.kind === "content_brief");
  const latest = briefs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const hoursSince = latest ? ageMinutes(latest.createdAt, view.now) / 60 : Infinity;
  if (hoursSince < 20) return [];
  return [
    {
      agentId: "signal",
      kind: "write_content_brief",
      reason:
        hoursSince === Infinity
          ? `No content brief has ever been written. The site has ${view.publishedPathCount} published pages and ${view.siteEvents.length} recorded visits.`
          : `Last content brief was ${Math.floor(hoursSince)}h ago.`,
      priority: 45,
      payload: { pageCount: view.publishedPathCount, visits: view.siteEvents.length },
      dedupeKey: `content-brief:${new Date(view.now).toISOString().slice(0, 10)}`,
    },
  ];
}

/** Paths whose repeated, anonymous visits are real buying interest, not crawling. */
const BUYING_PATHS = ["/rates", "/quote"];
const SERVICE_PATHS = [
  "/services/voip",
  "/services/networking",
  "/services/it-infrastructure",
  "/work",
];

function isBuyingPath(path: string): boolean {
  return (
    BUYING_PATHS.includes(path) || SERVICE_PATHS.includes(path) || path.startsWith("/services/")
  );
}

function planProspect(view: DutyView): PlannedWork[] {
  // Marketing's job is to notice demand the site already receives. Anonymous page
  // views are real records; turning repeat interest into a flagged lead is derived
  // work, not an invented customer. No contact is known, so nothing here reaches
  // the founder — qualification and the handoff gate do that.
  const work: PlannedWork[] = [];
  const counts = new Map<string, number>();
  for (const event of view.siteEvents) {
    if (!isBuyingPath(event.path)) continue;
    counts.set(event.path, (counts.get(event.path) ?? 0) + 1);
  }
  const today = new Date(view.now).toISOString().slice(0, 10);
  const already = new Set(view.leads.map((lead) => lead.companyName));
  for (const [path, count] of counts) {
    const highIntent = BUYING_PATHS.includes(path);
    if ((highIntent ? count >= 1 : count >= 2) === false) continue;
    const name = `Prospect · ${path}`;
    if (already.has(name)) continue;
    const scored = scoreLead(
      `${count} recorded visit(s) to ${path} with no enquiry filed yet.`,
      name,
    );
    work.push({
      agentId: "signal",
      kind: "prospect_from_site_signals",
      reason: `${path} was visited ${count} time(s) today with no enquiry filed — flagged interest, not a confirmed buyer.`,
      priority: highIntent ? 22 : 16,
      payload: {
        source: "site_signal",
        stage: "engaged",
        score: scored.score,
        path,
        visitCount: count,
        evidence: `${count} recorded visit(s) to ${path}; no enquiry follows them yet.`,
      },
      dedupeKey: `prospect:${path}:${today}`,
    });
  }
  return work;
}

/** One owned-channel campaign per week for nurtured demand that is not yet in sales. */
function planDraftCampaign(view: DutyView): PlannedWork[] {
  const weekStart = new Date(view.now).toISOString().slice(0, 10);
  const dedupeKey = `campaign:${weekStart}`;
  if (view.campaigns.some((campaign) => campaign.createdAt.slice(0, 10) === weekStart)) return [];
  const nurtured = view.leads.filter((lead) => {
    const isOpenDemand = lead.stage === "nurture" || lead.stage === "qualified";
    const alreadyInPipeline = lead.stage === "in_sales" || lead.stage === "lost";
    const hasPendingHandoff = view.approvalsPending.some(
      (approval) =>
        approval.kind === "sales_handoff" &&
        (approval.companyName ?? "").toLowerCase() === lead.companyName.toLowerCase(),
    );
    return isOpenDemand && !alreadyInPipeline && !hasPendingHandoff;
  });
  if (nurtured.length === 0) return [];
  return [
    {
      agentId: "signal",
      kind: "draft_campaign",
      reason: `Draft this week's owned-channel campaign for ${nurtured.length} nurtured lead(s) who are not yet in sales.`,
      priority: 40,
      payload: {
        channel: "owned",
        budgetCents: 0,
        leads: nurtured.map((lead) => ({
          id: lead.id,
          companyName: lead.companyName,
          stage: lead.stage,
          score: lead.score,
        })),
      },
      dedupeKey,
    },
  ];
}

function planQualifyLeads(view: DutyView): PlannedWork[] {
  // Qualification is a one-time transition out of "engaged", not a periodic
  // re-score: once a lead has a stage, scoring it again every few hours would
  // churn the decision chain and re-decide work already done. A lead whose
  // situation really changed arrives as a new inbound record, not a new score.
  return view.leads
    .filter((lead) => lead.stage === "engaged")
    .filter((lead) => lead.summary.trim().length > 0)
    .map((lead) => {
      const scored = scoreLead(`${lead.summary} ${lead.companyName}`, lead.companyName);
      return {
        agentId: "signal",
        kind: "qualify_lead",
        reason: `${lead.companyName} (stage ${lead.stage}) scores ${scored.score} from what they actually wrote.`,
        priority: 30 - Math.min(25, Math.round(scored.score / 4)),
        payload: {
          leadId: lead.id,
          companyName: lead.companyName,
          score: scored.score,
          reasons: scored.reasons,
          demand: scored.demand,
          support: scored.support,
          spam: scored.spam,
        },
        dedupeKey: `qualify:${lead.id}`,
      };
    });
}

/**
 * Marketing only files a sales handoff when the enquiry itself reads as buying
 * intent. Calibrated against `scoreLead`: a single vague message scores near
 * zero, unsolicited outreach is rejected outright, and a short but explicit
 * buying enquiry ("could you quote for 20 extensions") clears this bar.
 */
export const HANDOFF_THRESHOLD = 30;

function planHandoff(view: DutyView): PlannedWork[] {
  // Marketing stops at marketing. Anything that reads as genuine buying intent
  // and is not already in sales becomes a founder-gated handoff proposal.
  const pendingHandoff = new Set(
    view.approvalsPending
      .filter((a) => a.kind === "sales_handoff")
      .map((a) => (a.companyName ?? "").toLowerCase()),
  );
  const inSales = new Set(
    view.leads
      .filter((lead) => lead.stage === "in_sales" || lead.stage === "ready_for_sales")
      .map((lead) => lead.companyName.toLowerCase()),
  );
  const work: PlannedWork[] = [];
  const canOpen = delegated(view, "open_opportunity");
  for (const lead of view.leads) {
    const key = lead.companyName.toLowerCase();
    if (lead.stage === "lost" || inSales.has(key) || pendingHandoff.has(key)) continue;
    // A qualified lead with a real inbound record can be opened by Sales under
    // the delegation. Marketing does not need to file a founder handoff for
    // the same lead. A qualified lead with no inbound record still goes to the
    // founder, because Sales may not sell to it.
    if (canOpen && lead.stage === "qualified" && lead.inboundId) continue;
    const scored = scoreLead(lead.summary, lead.companyName);
    if (scored.spam || scored.score < HANDOFF_THRESHOLD || scored.demand === 0) continue;
    work.push({
      agentId: "signal",
      kind: "propose_sales_handoff",
      reason: `${lead.companyName}: ${scored.reasons.slice(0, 2).join("; ") || "reads as buying intent"}.`,
      priority: 12,
      payload: {
        leadId: lead.id,
        companyName: lead.companyName,
        score: scored.score,
        reasons: scored.reasons,
      },
      dedupeKey: `handoff:${lead.id}`,
    });
  }
  return work;
}

function planDiscovery(view: DutyView): PlannedWork[] {
  const work: PlannedWork[] = [];
  const opened = new Set(view.opportunities.map((opp) => opp.companyName.trim().toLowerCase()));
  const pendingHandoff = new Set(
    view.approvalsPending
      .filter((approval) => approval.kind === "sales_handoff")
      .map((approval) => (approval.companyName ?? "").trim().toLowerCase()),
  );

  if (delegated(view, "open_opportunity")) {
    for (const lead of view.leads) {
      const key = lead.companyName.trim().toLowerCase();
      if (lead.stage !== "qualified" || !lead.inboundId) continue;
      if (lead.score < 45 || opened.has(key) || pendingHandoff.has(key)) continue;
      if (!hasRealEnquiry(view, lead.companyName)) continue;
      work.push({
        agentId: "close",
        kind: "open_sales_opportunity",
        reason: `${lead.companyName} qualified from a real enquiry and no sales opportunity is open.`,
        priority: 10,
        payload: {
          leadId: lead.id,
          companyName: lead.companyName,
          score: lead.score,
          summary: lead.summary,
        },
        dedupeKey: `open-opportunity:${lead.id}`,
      });
    }
  }

  const alreadyQuoted = new Set(
    view.quotes.filter((quote) => quote.relatedId).map((quote) => quote.relatedId as string),
  );
  const discoveryFiled = new Set(
    view.documents
      .filter(
        (doc) =>
          doc.kind === "internal" && doc.relatedId && doc.title.startsWith("Discovery checklist"),
      )
      .map((doc) => doc.relatedId as string),
  );
  for (const opp of view.opportunities) {
    if (opp.stage !== "discovery") continue;
    if (discoveryFiled.has(opp.id)) continue;
    // When the office can price the quote itself, the quote duty owns this
    // opportunity. Advancing discovery as well would move the stage twice.
    if (!alreadyQuoted.has(opp.id) && autoQuoteFor(view, opp)) continue;
    work.push({
      agentId: "close",
      kind: "advance_discovery",
      reason: `${opp.companyName} is in discovery${opp.summary ? `: ${opp.summary.slice(0, 120)}` : ""}`,
      priority: 20,
      payload: { opportunityId: opp.id, companyName: opp.companyName },
      dedupeKey: `discovery:${opp.id}`,
    });
  }
  return work;
}

/**
 * Quote real demand from the published card.
 *
 * Sales may only do this under a delegation that covers quoting, and only for
 * a customer who actually contacted the office. The line is chosen by the
 * playbook, never by the model, and the governor re-prices it before it is
 * written down. The customer has not received the quote until the separate
 * notice duty emails it.
 */
function planCloseQuote(view: DutyView): PlannedWork[] {
  if (!view.delegation || view.delegation.status !== "active") return [];
  const quoted = new Set(
    view.quotes.filter((quote) => quote.relatedId).map((quote) => quote.relatedId as string),
  );
  const work: PlannedWork[] = [];
  for (const opp of view.opportunities) {
    if (opp.stage !== "discovery" || quoted.has(opp.id)) continue;
    const choice = autoQuoteFor(view, opp);
    if (!choice) continue;
    work.push({
      agentId: "close",
      kind: "issue_quote",
      reason: `${opp.companyName} asked for work the published card can price: ${choice.title} at ${(choice.amountCents / 100).toFixed(2)} ZAR. ${choice.why}.`,
      priority: 8,
      payload: {
        opportunityId: opp.id,
        companyName: opp.companyName,
        rateId: choice.rateId,
        location: choice.location,
        quantity: choice.quantity,
        amountCents: choice.amountCents,
        why: choice.why,
        scope: quoteScopeLines(choice),
      },
      dedupeKey: `quote:${opp.id}`,
    });
  }
  return work;
}

function planQuoteFollowUp(view: DutyView): PlannedWork[] {
  const links = new Map(view.quoteLinks.map((link) => [link.documentId, link]));
  const sentAt = new Map<string, number>();
  for (const quote of view.quotes) {
    if (quote.status !== "approved_unsent" || !quote.relatedId) continue;
    sentAt.set(quote.relatedId, (sentAt.get(quote.relatedId) ?? 0) + 1);
  }
  const work: PlannedWork[] = [];
  for (const opp of view.opportunities) {
    if (opp.stage !== "proposal") continue;
    if ((sentAt.get(opp.id) ?? 0) === 0) continue;
    const quote = view.quotes
      .filter((q) => q.kind === "quote" && q.relatedId === opp.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!quote) continue;
    const age = ageMinutes(quote.createdAt, view.now);
    if (age < 2 * DAY) continue;
    const link = links.get(quote.id);
    work.push({
      agentId: "close",
      kind: "draft_quote_followup",
      reason:
        `${opp.companyName} has had quote ${quote.title} out for ${Math.floor(age / DAY)} day(s)` +
        (link ? `; link viewed ${link.viewCount} time(s)` : "; no customer link created yet"),
      priority: 15,
      payload: {
        opportunityId: opp.id,
        companyName: opp.companyName,
        quoteId: quote.id,
        valueCents: opp.valueCents,
        daysWaiting: Math.floor(age / DAY),
        linkState: link?.state ?? "none",
        views: link?.viewCount ?? 0,
      },
      dedupeKey: `quote-followup:${quote.id}:${Math.floor(age / (3 * DAY))}`,
    });
  }
  return work;
}

function planStaleProposal(view: DutyView): PlannedWork[] {
  return view.opportunities
    .filter((opp) => opp.stage === "proposal")
    .filter((opp) => ageMinutes(opp.updatedAt, view.now) > 14 * DAY)
    .map((opp) => ({
      agentId: "close",
      kind: "review_cold_proposal",
      reason: `${opp.companyName} has had no movement for ${Math.floor(ageMinutes(opp.updatedAt, view.now) / DAY)} days on a ${(opp.valueCents / 100).toFixed(2)} ZAR proposal.`,
      priority: 25,
      payload: { opportunityId: opp.id, companyName: opp.companyName, valueCents: opp.valueCents },
      dedupeKey: `cold:${opp.id}:${Math.floor(ageMinutes(opp.updatedAt, view.now) / (14 * DAY))}`,
    }));
}

function planWinHandoff(view: DutyView): PlannedWork[] {
  const delivery = new Set(
    view.tickets.map((ticket) => ticket.relatedId).filter(Boolean) as string[],
  );
  const invoiced = new Set(
    view.ledger
      .filter((row) => row.kind === "invoice" && row.relatedId)
      .map((row) => row.relatedId as string),
  );
  // Under billing delegation, LEDGER's own duty raises the invoice when the
  // customer has accepted a quote. A sales nudge would tell the founder to do
  // work the office is already doing. A won job with no accepted quote still
  // needs a person, because billing has nothing it may bill against.
  const billingDelegated = delegated(view, "issue_invoice");
  const billingCap = billingDelegated ? (view.delegation?.maxAmountCents ?? 0) : 0;
  const accepted = new Set(
    view.quotes
      .filter((quote) => quote.kind === "quote" && quote.status === "accepted" && quote.relatedId)
      .map((quote) => quote.relatedId as string),
  );
  const work: PlannedWork[] = [];
  for (const opp of view.opportunities) {
    if (opp.stage !== "won") continue;
    if (!delivery.has(opp.id)) continue;
    if (invoiced.has(opp.id)) continue;
    if (
      billingDelegated &&
      accepted.has(opp.id) &&
      opp.valueCents > 0 &&
      opp.valueCents <= billingCap
    )
      continue;
    work.push({
      agentId: "close",
      kind: "nudge_invoice",
      reason: `${opp.companyName} accepted and delivery is open, but no invoice is on the books.`,
      priority: 18,
      payload: { opportunityId: opp.id, companyName: opp.companyName, valueCents: opp.valueCents },
      dedupeKey: `win-invoice:${opp.id}`,
    });
  }
  return work;
}

function planAcknowledge(view: DutyView): PlannedWork[] {
  const acked = new Set(
    view.documents
      .filter(
        (doc) => (doc.kind === "service_ack" || doc.kind === "correspondence") && doc.relatedId,
      )
      .map((doc) => doc.relatedId as string),
  );
  return view.tickets
    .filter(
      (ticket) =>
        ticket.ownerAgent === "desk" && ticket.status !== "resolved" && !acked.has(ticket.id),
    )
    .map((ticket) => ({
      agentId: "desk",
      kind: "acknowledge_ticket",
      reason: `${ticket.title} has no acknowledgement on file.`,
      priority: 22,
      payload: { ticketId: ticket.id, title: ticket.title, severity: ticket.severity },
      dedupeKey: `ack:${ticket.id}`,
    }));
}

function planSlaWatch(view: DutyView): PlannedWork[] {
  const limits: Record<string, number> = { p1: 4 * HOUR, p2: 24 * HOUR, p3: 7 * DAY };
  return view.tickets
    .filter((ticket) => ticket.status !== "resolved")
    .filter((ticket) => {
      const limit = limits[ticket.severity] ?? 7 * DAY;
      return ageMinutes(ticket.updatedAt, view.now) > limit;
    })
    .map((ticket) => ({
      agentId: "desk",
      kind: "escalate_ageing_ticket",
      reason: `${ticket.title} (${ticket.severity}) has had no movement for ${Math.floor(ageMinutes(ticket.updatedAt, view.now) / HOUR)} hours.`,
      priority: ticket.severity === "p1" ? 1 : 10,
      payload: { ticketId: ticket.id, title: ticket.title, severity: ticket.severity },
      dedupeKey: `sla:${ticket.id}:${Math.floor(ageMinutes(ticket.updatedAt, view.now) / limits[ticket.severity])}`,
    }));
}

function planChatReply(view: DutyView): PlannedWork[] {
  return view.chatThreads
    .filter((thread) => thread.status === "open" && thread.unansweredCount > 0)
    .filter(
      (thread) => (thread.lastMessageAt ? ageMinutes(thread.lastMessageAt, view.now) : 0) > 20,
    )
    .map((thread) => ({
      agentId: "desk",
      kind: "draft_chat_reply",
      reason: `${thread.name} has ${thread.unansweredCount} unanswered message(s).`,
      priority: 24,
      payload: { threadId: thread.id, name: thread.name },
      dedupeKey: `chat:${thread.id}`,
    }));
}

function planDiagnose(view: DutyView): PlannedWork[] {
  return view.tickets
    .filter((ticket) => ticket.ownerAgent === "forge" || ticket.ownerAgent === "keep")
    .filter((ticket) => ticket.status === "open")
    .filter((ticket) => !ticket.summary.startsWith("FORGE:"))
    .map((ticket) => ({
      agentId: ticket.ownerAgent === "keep" ? "keep" : "forge",
      kind: "diagnose_ticket",
      reason: `${ticket.title}: ${ticket.summary.slice(0, 160)}`,
      priority: ticket.severity === "p1" ? 3 : 28,
      payload: {
        ticketId: ticket.id,
        title: ticket.title,
        severity: ticket.severity,
        summary: ticket.summary,
      },
      dedupeKey: `diagnose:${ticket.id}`,
    }));
}

function planKnowledge(view: DutyView): PlannedWork[] {
  const written = new Set(
    view.documents.filter((doc) => doc.kind === "knowledge").map((doc) => doc.relatedId),
  );
  return view.tickets
    .filter((ticket) => ticket.status === "resolved" && ticket.summary.startsWith("FORGE:"))
    .filter((ticket) => !written.has(ticket.id))
    .map((ticket) => ({
      agentId: "forge",
      kind: "record_knowledge",
      reason: `${ticket.title} is resolved and its procedure is not in the knowledge base.`,
      priority: 60,
      payload: { ticketId: ticket.id, title: ticket.title },
      dedupeKey: `knowledge:${ticket.id}`,
    }));
}

function planChaseInvoice(view: DutyView): PlannedWork[] {
  return view.ledger
    .filter((row) => row.kind === "invoice" && row.status === "issued")
    .filter((row) => ageMinutes(row.createdAt, view.now) > 7 * DAY)
    .map((row) => ({
      agentId: "ledger",
      kind: "draft_invoice_chase",
      reason: `Invoice for ${row.counterparty} (${(row.amountCents / 100).toFixed(2)} ZAR) has been issued for ${Math.floor(ageMinutes(row.createdAt, view.now) / DAY)} days with no receipt.`,
      priority: 26,
      payload: { invoiceId: row.id, counterparty: row.counterparty, amountCents: row.amountCents },
      dedupeKey: `chase:${row.id}:${Math.floor(ageMinutes(row.createdAt, view.now) / (7 * DAY))}`,
    }));
}

function planPaymentNotices(view: DutyView): PlannedWork[] {
  return view.inbound
    .filter((item) => item.intent === "payment_notice" && item.status !== "filed")
    .map((item) => ({
      agentId: "ledger",
      kind: "verify_payment_notice",
      reason: `${item.companyName} says they paid. Treasury has not moved.`,
      priority: 14,
      payload: { inboundId: item.id, companyName: item.companyName, subject: item.subject },
      dedupeKey: `payment-notice:${item.id}`,
    }));
}

function planPayables(view: DutyView): PlannedWork[] {
  if (view.payableCents <= 0) return [];
  return [
    {
      agentId: "ledger",
      kind: "report_payables",
      reason: `There are ${(view.payableCents / 100).toFixed(2)} ZAR of payables on the books and no scheduled payment.`,
      priority: 35,
      payload: { payableCents: view.payableCents },
      dedupeKey: `payables:${new Date(view.now).toISOString().slice(0, 10)}`,
    },
  ];
}

function planRecords(view: DutyView): PlannedWork[] {
  const work: PlannedWork[] = [];
  for (const opp of view.opportunities) {
    if (opp.stage !== "won") continue;
    const hasDocuments = view.documents.some(
      (doc) =>
        doc.relatedId === opp.id &&
        (doc.kind === "quote" || doc.kind === "invoice" || doc.kind === "receipt"),
    );
    if (hasDocuments) continue;
    work.push({
      agentId: "keep",
      kind: "file_missing_records",
      reason: `${opp.companyName} is won but no quote, invoice or receipt is filed against it.`,
      priority: 32,
      payload: { opportunityId: opp.id, companyName: opp.companyName },
      dedupeKey: `records:${opp.id}`,
    });
  }
  return work;
}

function planChainVerify(view: DutyView): PlannedWork[] {
  if (view.chainIntact) return [];
  return [
    {
      agentId: "seal",
      kind: "halt_broken_chain",
      reason:
        "The audit hash chain does not verify. Autonomous actions are stopped until the founder looks.",
      priority: 0,
      maxAttempts: 1,
      payload: {},
      dedupeKey: `chain-broken:${view.now.slice(0, 13)}`,
    },
  ];
}

function planScopeAudit(view: DutyView): PlannedWork[] {
  // SEAL cannot stop an agent retroactively, but it can name the drift so the
  // founder can fix the agent definition.
  const rogue = view.approvalsPending.filter((approval) => approval.kind === "constraint_margin");
  if (!rogue.length) return [];
  return [
    {
      agentId: "seal",
      kind: "report_scope_drift",
      reason: `${rogue.length} escalation(s) were filed on confidence rather than a constitutional gate. An agent may be uncertain about its role.`,
      priority: 33,
      payload: {
        approvals: rogue.slice(0, 10).map((a) => ({ id: a.id, title: a.title, agent: a.kind })),
      },
      dedupeKey: `scope-drift:${new Date(view.now).toISOString().slice(0, 10)}`,
    },
  ];
}

function planChainAnchor(view: DutyView): PlannedWork[] {
  // The office records the audit-chain head once a day, whatever the chain's
  // state, so that a later rewrite — including one that happened while the
  // chain was already broken — can be detected against an earlier witness.
  // Chain verification itself is SEAL's job; anchoring only witnesses.
  return [
    {
      agentId: "seal",
      kind: "anchor_chain_head",
      reason:
        "Record the current audit-chain head so a later rewrite of the chain can be detected.",
      priority: 35,
      payload: {},
      dedupeKey: `chain-anchor:${new Date(view.now).toISOString().slice(0, 10)}`,
    },
  ];
}

// ── Recurring revenue and productised services ────────────────────────────────

/**
 * The billing duty.
 *
 * It plans one work item per subscription that is due. The period boundaries
 * come from the subscription's own next billing instant, so the office never
 * invents a date: the period is the one the contract says.
 */
function planSubscriptionBilling(view: DutyView): PlannedWork[] {
  return view.subscriptions
    .filter((sub) => sub.status === "active")
    .filter((sub) => Date.parse(sub.nextBillingAt) <= Date.parse(view.now))
    .map((sub) => ({
      agentId: "ledger",
      kind: "bill_subscription_cycle",
      reason: `${sub.companyName} is due for ${sub.planId} billing (R${(sub.priceCents / 100).toFixed(2)}) on ${sub.nextBillingAt.slice(0, 10)}.`,
      priority: 18,
      payload: {
        subscriptionId: sub.id,
        companyName: sub.companyName,
        planId: sub.planId,
        rateId: sub.rateId,
        priceCents: sub.priceCents,
        cycle: sub.cycle,
        periodStart: sub.nextBillingAt,
      },
      dedupeKey: `bill:${sub.id}:${sub.nextBillingAt}`,
    }));
}

/**
 * The fulfilment duty.
 *
 * A cycle that has been invoiced but not yet delivered is a promise the office
 * has made and not kept. This plans the work that closes that gap.
 */
function planServiceFulfilment(view: DutyView): PlannedWork[] {
  return view.billingCycles
    .filter((cycle) => cycle.status === "invoiced" || cycle.status === "paid")
    .filter((cycle) => !cycle.reportDocumentId)
    .map((cycle) => ({
      agentId: "desk",
      kind: "fulfil_service_cycle",
      reason: `${cycle.companyName} has been invoiced for ${cycle.planId} and the deliverable has not been produced.`,
      priority: 20,
      payload: {
        cycleId: cycle.id,
        subscriptionId: cycle.subscriptionId,
        companyName: cycle.companyName,
        planId: cycle.planId,
        amountCents: cycle.amountCents,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
      },
      dedupeKey: `fulfil:${cycle.id}`,
    }));
}

/**
 * The notice duty.
 *
 * The deliverable exists and the customer has not been told. This plans the
 * email that closes the loop.
 */
function planServiceNotice(view: DutyView): PlannedWork[] {
  const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
  // The attempt stamp comes from the database clock, so compare it with the
  // real clock rather than the injected view clock. In production they are the
  // same; in the deterministic verifier the view clock runs far ahead, and
  // using it here would retry every tick.
  const nowMs = Date.now();
  return view.billingCycles
    .filter((cycle) => cycle.status === "fulfilled" || cycle.status === "paid")
    .filter((cycle) => !cycle.notifiedAt && Boolean(cycle.reportDocumentId))
    .filter(
      (cycle) =>
        !cycle.lastNoticeAttemptAt ||
        nowMs - Date.parse(cycle.lastNoticeAttemptAt) >= RETRY_AFTER_MS,
    )
    .map((cycle) => ({
      agentId: "desk",
      kind: "send_service_notice",
      reason: `${cycle.companyName} has a delivered ${cycle.planId} report that has not been sent.`,
      priority: 22,
      payload: {
        cycleId: cycle.id,
        subscriptionId: cycle.subscriptionId,
        companyName: cycle.companyName,
        planId: cycle.planId,
        amountCents: cycle.amountCents,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
      },
      dedupeKey: `notice:${cycle.id}`,
    }));
}

/**
 * The billing duty.
 *
 * Won work with an accepted quote becomes an invoice. Under the same
 * delegation, the customer is then sent the invoice and, once money is
 * matched, a receipt. The store still enforces the money and mail gates; this
 * planner only proposes work that the real state supports.
 */
function planBilling(view: DutyView): PlannedWork[] {
  if (!delegated(view, "issue_invoice")) return [];
  const billingCap = view.delegation?.maxAmountCents ?? 0;
  const invoices = view.ledger.filter((row) => row.kind === "invoice");
  const invoiceByRelated = new Map(
    invoices.filter((row) => row.relatedId).map((row) => [row.relatedId as string, row]),
  );
  const accepted = view.quotes.filter(
    (quote) => quote.kind === "quote" && quote.status === "accepted",
  );
  const noticed = new Set(
    view.notices
      .filter((notice) => notice.relatedId)
      .map((notice) => `${notice.template}:${notice.relatedId}`),
  );
  const work: PlannedWork[] = [];

  for (const opp of view.opportunities) {
    if (opp.stage !== "won" || opp.valueCents <= 0) continue;
    if (invoiceByRelated.has(opp.id)) continue;
    const quote = accepted.find((item) => item.relatedId === opp.id);
    if (!quote) continue;
    // The accepted quote is the figure that will be invoiced, so the delegation
    // cap must be tested against it rather than a mutable opportunity value.
    const invoiceCents =
      quote.amountCents && quote.amountCents > 0 ? quote.amountCents : opp.valueCents;
    if (invoiceCents > billingCap) continue;
    work.push({
      agentId: "ledger",
      kind: "issue_won_invoice",
      reason: `${opp.companyName} accepted quote ${quote.title} and the work is won, but no invoice is on the books.`,
      priority: 6,
      payload: {
        opportunityId: opp.id,
        companyName: opp.companyName,
        quoteDocumentId: quote.id,
        valueCents: invoiceCents,
      },
      dedupeKey: `won-invoice:${opp.id}`,
    });
  }

  const canMail =
    Boolean(view.delegation?.allowCustomerMail) && delegated(view, "send_customer_mail");
  if (!canMail) return work;

  const cycleIds = new Set(view.billingCycles.map((cycle) => cycle.id));
  const invoiceDocuments = new Map(
    view.documents
      .filter((doc) => doc.kind === "invoice" && doc.relatedId)
      .map((doc) => [doc.relatedId as string, doc]),
  );
  for (const invoice of invoices) {
    if (!invoice.relatedId) continue;
    if (cycleIds.has(invoice.relatedId)) continue;
    if (!invoiceDocuments.has(invoice.relatedId)) continue;
    if (noticed.has(`invoice:${invoice.id}`)) continue;
    if (!hasRecipient(view, invoice.counterparty)) continue;
    work.push({
      agentId: "ledger",
      kind: "send_invoice_notice",
      reason: `${invoice.counterparty} has an invoice on file and has not been sent it.`,
      priority: 12,
      payload: {
        invoiceId: invoice.id,
        companyName: invoice.counterparty,
        amountCents: invoice.amountCents,
      },
      dedupeKey: `invoice-notice:${invoice.id}`,
    });
  }

  for (const receipt of view.ledger.filter((row) => row.kind === "receipt")) {
    if (!receipt.relatedId) continue;
    const invoice = invoices.find((row) => row.id === receipt.relatedId);
    if (!invoice) continue;
    if (noticed.has(`receipt:${receipt.id}`)) continue;
    if (!hasRecipient(view, receipt.counterparty)) continue;
    work.push({
      agentId: "ledger",
      kind: "send_receipt_notice",
      reason: `${receipt.counterparty} has a cleared receipt that has not been acknowledged.`,
      priority: 16,
      payload: {
        receiptId: receipt.id,
        invoiceId: invoice.id,
        companyName: receipt.counterparty,
        amountCents: receipt.amountCents,
      },
      dedupeKey: `receipt-notice:${receipt.id}`,
    });
  }
  return work;
}

/**
 * The dunning duty.
 *
 * Only plans a reminder when the office is allowed to email a customer, and
 * only between one and nine weeks after the invoice was raised. Past that the
 * matter goes back to the founder, because a customer who has been chased for
 * two months needs a person, not another email.
 */
function planDunning(view: DutyView): PlannedWork[] {
  if (!view.delegation || view.delegation.status !== "active") return [];
  if (!view.delegation.allowCustomerMail) return [];
  if (!view.delegation.allowedActions.includes("send_customer_mail")) return [];
  const lastReminder = new Map<string, string>();
  for (const notice of view.notices) {
    if (notice.template !== "payment_reminder" || !notice.relatedId) continue;
    const previous = lastReminder.get(notice.relatedId);
    if (!previous || Date.parse(notice.createdAt) > Date.parse(previous)) {
      lastReminder.set(notice.relatedId, notice.createdAt);
    }
  }
  return view.ledger
    .filter((row) => row.kind === "invoice" && row.status === "issued")
    .filter((row) => {
      const days = ageMinutes(row.createdAt, view.now) / DAY;
      return days >= 7 && days < 63;
    })
    .filter((row) => {
      const sentAt = lastReminder.get(row.id);
      return !sentAt || ageMinutes(sentAt, view.now) >= 7 * DAY;
    })
    .map((row) => ({
      agentId: "ledger",
      kind: "send_payment_reminder",
      reason: `Invoice for ${row.counterparty} (R${(row.amountCents / 100).toFixed(2)}) has been open for ${Math.floor(ageMinutes(row.createdAt, view.now) / DAY)} days.`,
      priority: 27,
      payload: { invoiceId: row.id, counterparty: row.counterparty, amountCents: row.amountCents },
      dedupeKey: `dunning:${row.id}:${Math.floor(ageMinutes(row.createdAt, view.now) / (7 * DAY))}`,
    }));
}

/**
 * The quote-notice duty.
 *
 * A quote the customer has not received is not a quote. This plans the email
 * that carries it, with a link they can accept on.
 */
function planQuoteNotice(view: DutyView): PlannedWork[] {
  if (!view.delegation || view.delegation.status !== "active") return [];
  if (!view.delegation.allowCustomerMail) return [];
  if (!view.delegation.allowedActions.includes("send_customer_mail")) return [];
  if (!view.delegation.allowedActions.includes("issue_quote")) return [];
  const linked = new Set(
    view.quoteLinks.filter((link) => link.state === "open").map((link) => link.documentId),
  );
  return view.quotes
    .filter((quote) => quote.status === "approved_unsent")
    .filter((quote) => !linked.has(quote.id))
    .map((quote) => ({
      agentId: "close",
      kind: "send_quote_notice",
      reason: `A quote is approved and waiting on the customer: ${quote.title}.`,
      priority: 25,
      payload: { documentId: quote.id },
      dedupeKey: `quote-notice:${quote.id}`,
    }));
}

/**
 * The subscription-starts duty.
 *
 * A customer who accepted a quote for a recurring plan has bought a
 * subscription, not a one-off job. This plans the work that records it, so
 * the office starts billing them on the schedule they agreed to.
 */
function planStartSubscription(view: DutyView): PlannedWork[] {
  const subscribed = new Set(view.subscriptions.map((sub) => sub.companyName.trim().toLowerCase()));
  const accepted = view.quotes.filter((quote) => quote.status === "accepted");
  const work: PlannedWork[] = [];
  for (const opp of view.opportunities) {
    if (opp.stage !== "won" || opp.valueCents <= 0) continue;
    if (subscribed.has(opp.companyName.trim().toLowerCase())) continue;
    const quote = accepted.find((item) => item.relatedId === opp.id);
    const plan = quote?.rateId ? planForRate(quote.rateId) : undefined;
    if (!plan || plan.cycle === "once") continue;
    work.push({
      agentId: "ledger",
      kind: "start_subscription_cycle",
      reason: `${opp.companyName} accepted a ${plan.title} quote and the subscription has not been started.`,
      priority: 17,
      payload: {
        opportunityId: opp.id,
        companyName: opp.companyName,
        planId: plan.id,
        rateId: plan.rateId,
        cycle: plan.cycle,
        priceCents: plan.priceCents,
        quoteDocumentId: quote?.id ?? null,
        acceptedAt: quote?.createdAt ?? opp.updatedAt,
      },
      dedupeKey: `start-subscription:${opp.id}`,
    });
  }
  return work;
}

/**
 * The recurring-revenue review.
 *
 * Weekly, and only worth running when there is something recurring to review.
 * It checks the health of the book and whether the published prices still
 * match the plans the office is selling.
 */
function planSubscriptionReview(view: DutyView): PlannedWork[] {
  if (!view.subscriptions.length) return [];
  const stale = view.subscriptions.filter(
    (sub) =>
      sub.status === "active" &&
      Date.parse(sub.nextBillingAt) < Date.parse(view.now) - 7 * DAY * 60_000,
  );
  const review = planRateCardIntegrity();
  if (!stale.length && review.ok) return [];
  return [
    {
      agentId: "keep",
      kind: "review_subscription_health",
      reason: stale.length
        ? `${stale.length} subscription(s) are past their billing date and were not billed.`
        : review.detail,
      priority: 34,
      payload: {
        stale: stale.map((sub) => ({ id: sub.id, companyName: sub.companyName })),
        rateCardOk: review.ok,
        rateCardDetail: review.detail,
      },
      dedupeKey: `subscription-review:${new Date(view.now).toISOString().slice(0, 10)}`,
    },
  ];
}

/** The published price card must still match the plans the office sells. */
export function planRateCardIntegrity(): { ok: boolean; detail: string } {
  return rateCardIntegrity();
}

// ── Published rate integrity ──────────────────────────────────────────────────

/** Machine-readable view of the published rate card, for briefs and audits. */
export type PriceGuideEntry = {
  id: string;
  title: string;
  scope: string;
  price: string;
  basis: string;
  cents: number;
  offered: boolean;
};

function toCents(price: string): number {
  // "R690 / hour" -> 69000. "R1,207.50 / hour" -> 120750.
  const match = price.replace(/,/g, "").match(/R\s*([\d.]+)/);
  if (!match) return 0;
  return Math.round(Number(match[1]) * 100) || 0;
}

export const PRICE_GUIDE: PriceGuideEntry[] = PUBLISHED_RATES.map((rate) => ({
  id: rate.id,
  title: rate.title,
  scope: rate.scope,
  price: rate.price,
  basis: rate.basis,
  cents: toCents(rate.price),
  offered: rate.offered,
}));

/**
 * The constitution says customer prices may only be the published rates. This is
 * the check that keeps that true, and it is also a self-test: if the rate card
 * and the quote engine ever disagree, the office says so instead of quietly
 * quoting something else.
 */
export function rateCardIntegrity(): { ok: boolean; detail: string } {
  const hourly = PUBLISHED_RATES.filter(
    (rate) => rate.offered && /per hour|\/ hour/.test(rate.price),
  );
  if (hourly.length < 2)
    return { ok: false, detail: "The published rate card no longer exposes hourly labour." };
  // Only labour lines must carry a single readable figure. Travel and supplier
  // costs are deliberately quoted per job, so they are not expected to parse.
  const unparsed = PRICE_GUIDE.filter(
    (rate) => rate.offered && rate.cents <= 0 && !/supplier|agreed|quoted/i.test(rate.price),
  );
  if (unparsed.length) {
    return {
      ok: false,
      detail: `${unparsed.length} published labour rate(s) could not be read as a figure: ${unparsed.map((r) => r.title).join(", ")}.`,
    };
  }
  return {
    ok: true,
    detail: `${PUBLISHED_RATES.length} published lines, ${hourly.length} of them hourly labour.`,
  };
}
