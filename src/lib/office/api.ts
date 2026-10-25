import { createServerFn } from "@tanstack/react-start";
import { clientKey, createRateLimiter, str, validEmail } from "./guard";
import { durableAllow } from "./rate-limit";
import { parseVatTreatment, paymentMethods } from "./invoice";
import { getSql } from "@/lib/db";
import { AGENT_BY_ID } from "./agents";
import { proposeActions } from "./ai.server";
import { listChats, founderReply, postChat, readChat } from "./chat.server";
import { processWebsiteEnquiry } from "./intake";
import {
  founderChatNotice,
  founderEnquiryNotice,
  founderPaymentNotice,
  founderQuoteAnswerNotice,
} from "./notice";
import { parseCustomerAnswer, plausibleToken } from "./quote-link";
import { founderMiddleware, isFounderToken, officeAccessMiddleware } from "./founder-gate";
import { priceQuote, type QuoteLocation } from "./quote";
import { operateFloor } from "./floor.server";
import {
  answerPublicQuote,
  appendAudit,
  applyProposedAction,
  createQuoteLink,
  listQuoteLinks,
  readPublicQuote,
  revokeQuoteLinks,
  exportBackupJson,
  restoreBackupJson,
  compactState,
  ensureOffice,
  filePaymentNotice,
  founderClose,
  logInboundItem,
  logServiceTime,
  listServiceTime,
  raiseQuoteInvoice,
  readSnapshot,
  recordInvoiceReceipt,
  dismissPaymentNotice,
  resolveApproval,
  skipApproval as writeSkipApproval,
  readGovernanceRecord,
  savePaymentInstructions,
  setOfficeHalt,
  setTicketStatus,
  readDelegation,
  readDelegationUsage,
  saveDelegation,
  revokeDelegation,
  listSubscriptions,
  listBillingCycles,
  listCustomerAccounts,
  listSiteSignals,
  revenueMetrics,
  startSubscriptionForOpportunity,
  cancelSubscriptionById,
  listCustomerNotices,
  getApprovalContext as readApprovalContext,
  listDecisionEpisodes as readDecisionEpisodes,
} from "./store.server";
import { writeCostCeilings } from "./cost-ceilings.server";
import { listProducts, getProduct, createProduct, updateProduct, deleteProduct } from "./products.server";
import { createPortalLink, resolvePortalLink, readCustomerAccount } from "./customer-portal.server";
import { DELEGATABLE_ACTIONS, DELEGATION_PRESETS } from "./delegation";
import { tick, runNow, schedulerStatus } from "./scheduler.server";
import { publicStatus } from "./public-status";
import type { OfficeHealth } from "./health.server";
import { listWork, workCounts } from "./work-queue.server";
import { redriveAbandonedWork } from "./redrive.server";
import type { DispatchResult, OfficeSnapshot, ProposedAction } from "./types";

async function applyPlan(
  agentId: string,
  task: string,
  actions: ProposedAction[],
  briefing: string,
): Promise<DispatchResult> {
  const agent = AGENT_BY_ID[agentId];
  const decisionIds: string[] = [];
  const approvalIds: string[] = [];
  let executed = 0;
  let escalated = 0;
  let blocked = 0;

  for (const action of actions) {
    const result = await applyProposedAction(agentId, action, {
      task,
      agent: agent?.callsign ?? agentId,
    });
    decisionIds.push(result.decisionId);
    if (result.approvalId) approvalIds.push(result.approvalId);
    if (result.status === "executed") executed += 1;
    else if (result.status === "escalated") escalated += 1;
    else blocked += 1;
  }

  return {
    ok: true,
    briefing,
    executed,
    escalated,
    blocked,
    decisionIds,
    approvalIds,
  };
}

function emptyFail(error: string): DispatchResult {
  return {
    ok: false,
    briefing: "",
    error,
    executed: 0,
    escalated: 0,
    blocked: 0,
    decisionIds: [],
    approvalIds: [],
  };
}

/**
 * Opportunistic scheduler nudge for surfaces that already prove the office is
 * alive (`/api/health`, the site-view beacon, the founder opening the floor).
 *
 * Free scheduling tiers throttle frequent cron runs, so a hit on one of those
 * surfaces may start a catch-up tick when the last one is old. Bounded by
 * `waitMs`: the caller stops waiting, the tick keeps running, and the next hit
 * retries. Guarded in `kick.server.ts` — autonomy gate, circuit breaker,
 * in-flight throttle — so this can never double-plan work.
 */
export const nudgeScheduler = createServerFn({ method: "POST" })
  .validator((input: { waitMs?: number }) => ({
    waitMs: Math.max(0, Math.min(Number(input?.waitMs ?? 2_500), 10_000)),
  }))
  .handler(async ({ data }): Promise<{ kicked: boolean; reason: string }> => {
    const { kickFloorIfStale } = await import("./kick.server");
    const attempt = kickFloorIfStale()
      .then((outcome: { kicked: boolean; detail?: string; reason?: string }) =>
        outcome.kicked
          ? { kicked: true, reason: outcome.detail ?? "" }
          : { kicked: false, reason: outcome.reason ?? "" },
      )
      .catch((error: unknown) => ({
        kicked: false,
        reason: error instanceof Error ? error.message : "The nudge failed.",
      }));
    if (!data.waitMs) return { kicked: false, reason: "not waited for" };
    return Promise.race([
      attempt,
      new Promise<{ kicked: boolean; reason: string }>((resolve) => {
        // Ref'd on purpose: this timer is the hard bound on how long the
        // surface can wait, even if the database hangs underneath the tick.
        setTimeout(
          () => resolve({ kicked: false, reason: `still running after ${data.waitMs}ms` }),
          data.waitMs,
        );
      }),
    ]);
  });

export const getOfficeSnapshot = createServerFn({ method: "GET" })
  .middleware([officeAccessMiddleware])
  .handler(
    async ({
      context,
    }): Promise<{ locked: true } | { locked: false; snapshot: OfficeSnapshot }> => {
      if (!context.founder) return { locked: true };
      // The founder opening the floor is the best possible moment to catch up,
      // so a stale scheduler is nudged before the snapshot is read. Founder-only
      // on purpose: anonymous visits must never start work.
      await nudgeScheduler({ data: { waitMs: 2_000 } }).catch(() => undefined);
      return { locked: false, snapshot: await readSnapshot() };
    },
  );

const enquiryLimiter = createRateLimiter(8, 60 * 60 * 1000);
const paymentLimiter = createRateLimiter(8, 60 * 60 * 1000);
const chatLimiter = createRateLimiter(40, 60 * 60 * 1000);
/**
 * Budget for `safeIntervalMs(PUBLIC_CHAT_READS_PER_HOUR)` at
 * `PUBLIC_CHAT_IDLE_INTERVAL_MS`, plus headroom for a visitor who leaves the
 * panel open and posts. The floor previously polled at 4s against a 120/hour
 * limit and locked itself out.
 */
const chatReadLimiter = createRateLimiter(240, 60 * 60 * 1000);
const siteViewLimiter = createRateLimiter(120, 60 * 60 * 1000);

function callerKey(request: Request | undefined): string {
  return clientKey(request?.headers);
}

async function allowEnquiry(key: string): Promise<boolean> {
  if (!enquiryLimiter.allow(key)) return false;
  return durableAllow(await getSql(), "enquiry", key, 8, 60 * 60 * 1000, Date.now(), () =>
    enquiryLimiter.allow(key),
  );
}

async function allowPaymentNotice(key: string): Promise<boolean> {
  if (!paymentLimiter.allow(key)) return false;
  return durableAllow(await getSql(), "payment_notice", key, 8, 60 * 60 * 1000, Date.now(), () =>
    paymentLimiter.allow(key),
  );
}

async function allowChat(key: string): Promise<boolean> {
  if (!chatLimiter.allow(key)) return false;
  return durableAllow(await getSql(), "chat", key, 40, 60 * 60 * 1000, Date.now(), () =>
    chatLimiter.allow(key),
  );
}

async function allowSiteView(key: string): Promise<boolean> {
  if (!siteViewLimiter.allow(key)) return false;
  return durableAllow(await getSql(), "site_view", key, 120, 3600_000, Date.now(), () =>
    siteViewLimiter.allow(key),
  );
}

async function allowChatRead(key: string): Promise<boolean> {
  if (!chatReadLimiter.allow(key)) return false;
  return durableAllow(await getSql(), "chat_read", key, 120, 60 * 60 * 1000, Date.now(), () =>
    chatReadLimiter.allow(key),
  );
}

const SERVICE_MATTERS = ["fault", "question", "complaint"] as const;

function serviceMatter(value: unknown): (typeof SERVICE_MATTERS)[number] | undefined {
  return SERVICE_MATTERS.find((matter) => matter === value);
}

export const submitPublicEnquiry = createServerFn({ method: "POST" })
  .validator(
    (input: {
      name: string;
      email: string;
      message: string;
      website?: string;
      desk?: boolean;
      matter?: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    if (str(data.website, 200).trim()) return { ok: true as const };
    const name = str(data.name, 400).trim();
    const email = str(data.email, 400).trim();
    const message = str(data.message, 6000).trim();
    const matter = serviceMatter(data.matter);
    const desk = data.desk === true || matter !== undefined;
    if (name.length < 2 || name.length > 160) {
      return { ok: false as const, error: "Enter the name we should use." };
    }
    if (!validEmail(email)) {
      return { ok: false as const, error: "Enter a real email address." };
    }
    if (message.length < 5 || message.length > 3000) {
      return { ok: false as const, error: "Describe the work in a few sentences." };
    }
    let request: Request | undefined;
    try {
      const server = await import("@tanstack/react-start/server");
      request = server.getRequest();
    } catch {
      request = undefined;
    }
    if (!(await allowEnquiry(callerKey(request)))) {
      return {
        ok: false as const,
        error: "Too many enquiries from this connection. Try again later.",
      };
    }
    const subject = message.replace(/\s+/g, " ").slice(0, 90);
    const source = desk
      ? "Source: vantage-ars.co.za customer service desk. No automated reply sent."
      : "Source: vantage-ars.co.za enquiry form. No automated reply sent.";
    const id = await logInboundItem({
      channel: "web",
      companyName: name,
      subject,
      summary: `Email: ${email}\n${source}${matter ? `\nMatter: ${matter}` : ""}\n\n${message}`,
      intent: desk ? "support" : "enquiry",
    });
    const snapshot = await readSnapshot();
    if (!snapshot.company.halted) {
      try {
        await processWebsiteEnquiry({ inboundId: id, name, message, desk, matter });
      } catch {
        // The enquiry is already on file. Routing can be retried from the inbox.
      }
    }
    try {
      const { deliverFounderNotice } = await import("./notify.server");
      await deliverFounderNotice(
        founderEnquiryNotice({
          name,
          email,
          subject,
          desk,
          excerpt: message,
        }),
      );
    } catch {
      // The enquiry is already on file.
    }
    return { ok: true as const };
  });

export const submitPaymentNotice = createServerFn({ method: "POST" })
  .validator(
    (input: { name: string; email: string; reference: string; amount: string; website?: string }) =>
      input,
  )
  .handler(async ({ data }) => {
    if (str(data.website, 200).trim()) return { ok: true as const };
    const email = str(data.email, 400).trim();
    if (!validEmail(email)) {
      return { ok: false as const, error: "Enter a real email address." };
    }
    let request: Request | undefined;
    try {
      const server = await import("@tanstack/react-start/server");
      request = server.getRequest();
    } catch {
      request = undefined;
    }
    if (!(await allowPaymentNotice(callerKey(request)))) {
      return {
        ok: false as const,
        error: "Too many notices from this connection. Try again later.",
      };
    }
    const filed = await filePaymentNotice({
      name: str(data.name, 400),
      email,
      reference: str(data.reference, 400),
      amount: str(data.amount, 100),
    });
    if (!filed.ok) return filed;
    try {
      const { parsePaymentNotice } = await import("./payment-notice");
      const parsed = parsePaymentNotice({
        name: str(data.name, 400),
        reference: str(data.reference, 400),
        amount: str(data.amount, 100),
      });
      if (parsed.ok) {
        const { deliverFounderNotice } = await import("./notify.server");
        await deliverFounderNotice(
          founderPaymentNotice({
            name: parsed.name,
            email,
            reference: parsed.reference,
            cents: parsed.cents,
          }),
        );
      }
    } catch {
      // The notice is already on file.
    }
    return { ok: true as const };
  });

export const filePaymentClaim = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { inboundId: string }) => input)
  .handler(async ({ data }) => dismissPaymentNotice(data.inboundId));

export const postPublicChat = createServerFn({ method: "POST" })
  .validator((input: { threadId: string; name: string; body: string; website?: string }) => input)
  .handler(async ({ data }) => {
    if (str(data.website, 200).trim()) return { ok: true as const, messages: [] };
    let request: Request | undefined;
    try {
      const server = await import("@tanstack/react-start/server");
      request = server.getRequest();
    } catch {
      request = undefined;
    }
    if (!(await allowChat(callerKey(request)))) {
      return {
        ok: false as const,
        error: "Too many messages from this connection. Try again later.",
      };
    }
    const chatSender = str(data.name, 200);
    const chatText = str(data.body, 2000);
    const result = await postChat({
      threadId: str(data.threadId, 80),
      name: chatSender,
      body: chatText,
    });
    if (!result.ok) return result;
    if (result.first) {
      try {
        const { deliverFounderNotice } = await import("./notify.server");
        await deliverFounderNotice(founderChatNotice({ name: chatSender, excerpt: chatText }));
      } catch {
        // The chat is already on file.
      }
    }
    return { ok: true as const, messages: result.messages };
  });

export const readPublicChat = createServerFn({ method: "POST" })
  .validator((input: { threadId: string }) => input)
  .handler(async ({ data }) => {
    const threadId = str(data.threadId, 80);
    let request: Request | undefined;
    try {
      const server = await import("@tanstack/react-start/server");
      request = server.getRequest();
    } catch {
      request = undefined;
    }
    if (!(await allowChatRead(callerKey(request)))) {
      return {
        ok: false as const,
        error: "Too many chat requests from this connection. Try again later.",
      };
    }
    return { ok: true as const, messages: await readChat(threadId) };
  });

export const listOfficeChats = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => listChats());

/**
 * Founder-authenticated chat read.
 *
 * The public read path is rate limited hard, because it is reachable by anyone.
 * The founder's desk is not, and it needs to poll faster to be usable — so it
 * gets its own function rather than borrowing the visitor's budget, which is
 * what made both desks throttle themselves out after eight minutes.
 */
export const readOfficeChat = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { threadId: string }) => ({ threadId: str(input?.threadId, 80) }))
  .handler(async ({ data }) => ({ ok: true as const, messages: await readChat(data.threadId) }));

export const replyOfficeChat = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { threadId: string; body: string }) => input)
  .handler(async ({ data }) => founderReply(data.threadId, data.body));

export const getCostCeilings = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => {
    const { readCostCeilings } = await import("./cost-ceilings.server");
    return readCostCeilings();
  });

export const saveCostCeilings = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { capsule?: number; fire?: number; daily?: number; monthly?: number }) => input)
  .handler(async ({ data }) => {
    await writeCostCeilings(data, "founder");
    const { readCostCeilings } = await import("./cost-ceilings.server");
    return await readCostCeilings();
  });

export const createCustomerPortalLink = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { companyName: string; days?: number }) => input)
  .handler(async ({ data }) => {
    return await createPortalLink({ companyName: data.companyName, days: data.days });
  });

export const getCustomerPortal = createServerFn({ method: "POST" })
  .validator((input: { token: string }) => input)
  .handler(async ({ data }) => {
    const resolved = await resolvePortalLink(data.token);
    if (!resolved) return { ok: false as const, error: "This link is not valid, has expired, or has been withdrawn." };
    const account = await readCustomerAccount(resolved.companyName);
    return { ok: true as const, account };
  });

export const getProducts = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => listProducts());

export const getProductById = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => getProduct(data.id));

export const createProductEntry = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { id?: string; title: string; scope: string; price: string; basis: string; offered: boolean; category: string }) => input)
  .handler(async ({ data }) => createProduct(data));

export const updateProductEntry = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { id: string; patch: Record<string, unknown> }) => input)
  .handler(async ({ data }) => updateProduct(data.id, data.patch as never));

export const deleteProductEntry = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    await deleteProduct(data.id);
    return { ok: true };
  });

export const getPublicProducts = createServerFn({ method: "GET" }).handler(async () => {
  const { listProducts } = await import("./products.server");
  const products = await listProducts(true);
  return products;
});

export const haltOffice = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { halted: boolean; reason: string }) => input)
  .handler(async ({ data }) => {
    const reason = data.reason.trim() || (data.halted ? "Founder halt." : "Resumed.");
    await setOfficeHalt(data.halted, reason);
    return readSnapshot();
  });

export const submitInbound = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator(
    (input: {
      channel: string;
      companyName: string;
      subject: string;
      summary: string;
      intent: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    const companyName = data.companyName.trim();
    const subject = data.subject.trim();
    const summary = data.summary.trim();
    if (!companyName || !subject || !summary) {
      return { ok: false as const, error: "Company, subject, and summary are required." };
    }
    const id = await logInboundItem({
      channel: data.channel.trim() || "direct",
      companyName,
      subject,
      summary,
      intent: data.intent.trim() || "unclassified",
    });

    const snapshot = await readSnapshot();
    if (snapshot.company.halted) {
      return { ok: true as const, id, routed: false as const };
    }

    const plan = await proposeActions({
      agentId: "foyer",
      task: [
        `Route inbound ${id} from company "${companyName}".`,
        `Channel: ${data.channel.trim() || "direct"}. Intent: ${data.intent.trim() || "unclassified"}.`,
        `Subject: ${subject}`,
        `Summary: ${summary}`,
        "Use relatedId of the inbound item. Create a lead only if this is genuine demand.",
        "Do not sell, quote, or spend. If it is support, open a ticket for FORGE.",
      ].join("\n"),
      state: compactState(snapshot),
    });

    if (!plan.ok) {
      return { ok: true as const, id, routed: false as const, briefing: plan.error };
    }

    const actions = plan.actions.map((action) => ({
      ...action,
      relatedId: action.relatedId || id,
      companyName: action.companyName || companyName,
    }));
    const dispatch = await applyPlan("foyer", `Route inbound ${id}`, actions, plan.briefing);
    return {
      ok: true as const,
      id,
      routed: true as const,
      briefing: dispatch.briefing,
      executed: dispatch.executed,
      escalated: dispatch.escalated,
      blocked: dispatch.blocked,
    };
  });

export const fileQuote = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator(
    (input: { opportunityId: string; rateId: string; location: QuoteLocation; quantity: number }) =>
      input,
  )
  .handler(async ({ data }) => {
    const location: QuoteLocation = data.location === "onsite" ? "onsite" : "remote";
    const priced = priceQuote({
      rateId: data.rateId,
      location,
      quantity: Number(data.quantity),
    });
    if (!priced.ok) return { ok: false as const, error: priced.error };
    const snapshot = await readSnapshot();
    if (snapshot.company.halted) return { ok: false as const, error: "Office is halted." };
    const opportunity = snapshot.opportunities.find((item) => item.id === data.opportunityId);
    if (!opportunity)
      return { ok: false as const, error: "That opportunity is not on the pipeline." };
    if (opportunity.stage === "won" || opportunity.stage === "lost") {
      return { ok: false as const, error: "This opportunity is already closed." };
    }
    const result = await applyProposedAction(
      "close",
      {
        kind: "issue_quote",
        title: `Quote · ${priced.title}`,
        rationale: priced.detail,
        confidence: 0.92,
        amountCents: priced.cents,
        companyName: opportunity.companyName,
        relatedId: opportunity.id,
        payload: {
          rateId: data.rateId,
          location,
          quantity: Number(data.quantity),
          body: priced.body,
        },
      },
      { source: "sales-desk" },
    );
    if (result.status === "blocked") {
      return {
        ok: false as const,
        error: "Sales cannot quote this company yet. Approve the marketing handoff first.",
      };
    }
    return { ok: true as const, status: result.status };
  });

export const recordCustomerAnswer = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { opportunityId: string; outcome: "won" | "lost" }) => input)
  .handler(async ({ data }) => {
    const outcome = data.outcome === "lost" ? "lost" : "won";
    return founderClose({ opportunityId: data.opportunityId, outcome });
  });

export const raiseInvoice = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { opportunityId: string; vatTreatment?: string }) => input)
  .handler(async ({ data }) =>
    raiseQuoteInvoice(data.opportunityId, parseVatTreatment(data.vatTreatment)),
  );

export const recordReceipt = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { invoiceId: string }) => input)
  .handler(async ({ data }) => recordInvoiceReceipt(data.invoiceId));

export const updateTicket = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { ticketId: string; status: "in_progress" | "resolved" }) => input)
  .handler(async ({ data }) => {
    const status = data.status === "resolved" ? "resolved" : "in_progress";
    return setTicketStatus(data.ticketId, status);
  });

export const savePaymentNote = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { text: string }) => input)
  .handler(async ({ data }) => savePaymentInstructions(data.text ?? ""));

/**
 * Founder decides a queued action.
 *
 * A POPIA section 71 decision carries the founder's own reasoning: the reason
 * code, the reasoning itself, and the evidence that was shown. The office
 * refuses to resolve a legal approval without them, so they are passed
 * straight through to the store.
 */
export const decideApproval = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator(
    (input: {
      approvalId: string;
      decision: "approved" | "rejected";
      note?: string;
      reasoning?: string;
      reasonCode?: string;
      evidenceShown?: string;
    }) => ({
      approvalId: str(input?.approvalId, 100),
      decision: input?.decision === "rejected" ? ("rejected" as const) : ("approved" as const),
      note: str(input?.note, 2000),
      reasoning: str(input?.reasoning, 2000),
      reasonCode: str(input?.reasonCode, 100),
      evidenceShown: str(input?.evidenceShown, 2000),
    }),
  )
  .handler(async ({ data }) => {
    const result = await resolveApproval(data);
    if (!result.ok) return { ok: false as const, error: result.error ?? "Could not resolve." };
    return { ok: true as const };
  });

/**
 * Everything the founder needs to decide one approval, in one object.
 *
 * The approval itself, the risk tier it sits in, the POPIA section 71 gate and
 * its five questions, whether a written reason is required before the action
 * may be exposed, the fixed reason codes, the earlier rulings on the same
 * terms, and what those rulings say about this one.
 */
export const getApprovalContext = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .validator((input: { approvalId: string }) => ({ approvalId: str(input?.approvalId, 100) }))
  .handler(async ({ data }) => readApprovalContext(data.approvalId));

/**
 * The founder's precedent history: every Tier 1–3 ruling, newest first.
 *
 * A precedent is evidence, never authority. It shows what was decided before
 * under which conditions; it never decides anything by itself.
 */
export const listDecisionEpisodes = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .validator((input: { limit?: number }) => ({
    limit: Math.max(1, Math.min(Math.trunc(Number(input?.limit ?? 50)) || 50, 200)),
  }))
  .handler(async ({ data }) => readDecisionEpisodes(data.limit));

/**
 * Close a waiting approval without a ruling. It is not an approval, it is not a
 * rejection, and nothing is executed.
 */
export const skipApproval = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { approvalId: string; note?: string }) => ({
    approvalId: str(input?.approvalId, 100),
    note: str(input?.note, 2000),
  }))
  .handler(async ({ data }) => writeSkipApproval(data));

/** Decision episodes, §71 gate records and signed receipts in one read. */
export const getGovernanceRecord = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .validator((input: { limit?: number }) => ({
    limit: Math.max(1, Math.min(Math.trunc(Number(input?.limit ?? 100)) || 100, 500)),
  }))
  .handler(async ({ data }) => readGovernanceRecord(data.limit));

/** Record support time against an account. */
export const recordServiceTime = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator(
    (input: { companyName: string; minutes: number; note: string; workedAt?: string }) => ({
      companyName: str(input?.companyName, 160),
      minutes: Math.trunc(Number(input?.minutes) || 0),
      note: str(input?.note, 500),
      workedAt: str(input?.workedAt, 20),
    }),
  )
  .handler(async ({ data }) => logServiceTime(data));

/** Recent support-time entries. */
export const getServiceTime = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .validator((input: { limit?: number }) => ({
    limit: Math.max(1, Math.min(Math.trunc(Number(input?.limit ?? 50)) || 50, 200)),
  }))
  .handler(async ({ data }) => listServiceTime(data.limit));

export const dispatchAgent = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { agentId: string; task: string }) => input)
  .handler(async ({ data }): Promise<DispatchResult> => {
    await ensureOffice();
    const agent = AGENT_BY_ID[data.agentId];
    if (!agent) return emptyFail("Unknown agent.");
    const task = data.task.trim();
    if (task.length < 8) return emptyFail("Give the agent a real brief — at least a sentence.");

    const snapshot = await readSnapshot();
    if (snapshot.company.halted) return emptyFail("Office is halted. Resume before dispatching.");

    const plan = await proposeActions({
      agentId: data.agentId,
      task,
      state: compactState(snapshot),
    });
    if (!plan.ok) return emptyFail(plan.error);

    return applyPlan(data.agentId, task, plan.actions, plan.briefing);
  });

export const runFloor = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .handler(async (): Promise<DispatchResult> => {
    await ensureOffice();
    const snapshot = await readSnapshot();
    if (snapshot.company.halted)
      return emptyFail("Office is halted. Resume before running the floor.");
    // The founder button runs the floor path (operateFloor). The scheduler's
    // unattended path (tick / runNow) is invoked independently by the cron and
    // by runAutonomy, so the button does not double-run duties already due.
    const result = await operateFloor();
    return {
      ok: true,
      briefing: result.briefing,
      executed: result.executed,
      escalated: 0,
      blocked: 0,
      decisionIds: [],
      approvalIds: [],
    };
  });

/** Founder-triggered autonomous run, with the scheduler's own report. */
export const runAutonomy = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .handler(async () => {
    await ensureOffice();
    return runNow();
  });

/** What the office is doing, why, and when each duty is next due. */
export const getSchedulerStatus = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => schedulerStatus());

/** The live work queue and the last runs, for the Floor page. */
export const getWorkQueue = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => {
    const items = await listWork(120);
    return {
      counts: await workCounts(),
      items: items.map((item) => ({
        id: item.id,
        agentId: item.agentId,
        kind: item.kind,
        reason: item.reason,
        status: item.status,
        priority: item.priority,
        attempts: item.attempts,
        maxAttempts: item.maxAttempts,
        dueAt: item.dueAt,
        outcome: item.outcome,
        lastError: item.lastError,
      })),
    };
  });

export const downloadBackup = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .handler(async () => ({
    ok: true as const,
    filename: `vantage-ars-backup-${new Date().toISOString().slice(0, 10)}.json`,
    json: await exportBackupJson(),
  }));

export const getPaymentMethods = createServerFn({ method: "GET" }).handler(async () =>
  paymentMethods(process.env),
);

/**
 * Scheduled autonomous run for `GET /api/cron/floor`.
 *
 * Authenticated by `CRON_SECRET` (NOT the founder session — the scheduler has no
 * cookies) and gated on `AUTONOMY=on`, so an unattended office is a deliberate
 * choice rather than a default. Lives here so the `.server` imports stay inside
 * an exempt server-function handler.
 */
export const runOfficeCron = createServerFn({ method: "POST" })
  .validator((input: { secret: string }) => ({
    secret: typeof input?.secret === "string" ? input.secret : "",
  }))
  .handler(
    async ({
      data,
    }): Promise<
      | {
          ok: true;
          ranAt: string;
          planned: number;
          executed: number;
          escalated: number;
          blocked: number;
          failed: number;
          ran: { duty: string; owner: string; note: string }[];
          detail: string;
        }
      | { ok: false; reason: string }
    > => {
      const expected = process.env.CRON_SECRET?.trim() ?? "";
      if (expected.length < 16 || !secretEqual(data.secret, expected)) {
        return { ok: false, reason: "Unauthorized" };
      }
      if (process.env.AUTONOMY?.trim().toLowerCase() !== "on") {
        return { ok: false, reason: "AUTONOMY is not on." };
      }
      try {
        const result = await tick();
        if (!result.ok) return { ok: false, reason: result.detail };
        if (result.planned + result.ran.length > 0) {
          await appendAudit("office_tick", "Scheduled autonomous run", result.detail, "vantage");
        }
        return {
          ok: true,
          ranAt: result.ranAt,
          planned: result.planned,
          executed: result.executed,
          escalated: result.escalated,
          blocked: result.blocked,
          failed: result.failed,
          ran: result.ran.map((entry) => ({
            duty: entry.duty,
            owner: entry.owner,
            note: entry.note,
          })),
          detail: result.detail,
        };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "The run failed." };
      }
    },
  );

/** Constant-time string compare without node:crypto (safe anywhere). */
function secretEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const restoreBackup = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { json: string }) => ({
    json: typeof input?.json === "string" ? input.json : "",
  }))
  .handler(async ({ data }) => restoreBackupJson(data.json));

// ── Delegated authority and recurring revenue ─────────────────────────────────

/** The founder's standing delegation, and how much of it has been used. */
export const getDelegation = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => {
    const delegation = await readDelegation();
    const usage = delegation ? await readDelegationUsage(delegation.id) : null;
    return {
      delegation,
      usage,
      presets: DELEGATION_PRESETS,
      delegatableActions: DELEGATABLE_ACTIONS,
    };
  });

/** Save the delegation. This is the founder writing down how far the office may go. */
export const saveDelegationPolicy = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator(
    (input: {
      label: string;
      status?: "active" | "paused";
      maxAmountCents: number;
      maxActionsPerDay: number;
      maxActionsPerMonth: number;
      allowedActions: string[];
      allowedRateIds: string[];
      allowCustomerMail: boolean;
      allowAutoReconcile: boolean;
      requireAcceptedQuote: boolean;
    }) => input,
  )
  .handler(async ({ data }) => saveDelegation(data));

/** Revoke the delegation. It takes effect on the very next action. */
export const revokeDelegationPolicy = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { reason: string }) => ({ reason: str(input?.reason, 400) }))
  .handler(async ({ data }) => revokeDelegation(data.reason || "Revoked by the founder."));

/** Every company the office has touched, assembled from its own records. */
export const getCustomers = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => listCustomerAccounts());

/** Real page views and referral sources from the public site, founder only. */
export const getSiteSignals = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => listSiteSignals(30));

/** The recurring-revenue book: subscriptions, billing periods, and the money. */
export const getRevenue = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => ({
    subscriptions: await listSubscriptions(),
    cycles: await listBillingCycles(120),
    metrics: await revenueMetrics(),
  }));

/** Start a subscription for a won opportunity, on the founder's instruction. */
export const startSubscription = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { opportunityId: string; planId: string }) => input)
  .handler(async ({ data }) => startSubscriptionForOpportunity(data.opportunityId, data.planId));

/** End a subscription. The customer outcome is a founder decision. */
export const cancelSubscription = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { subscriptionId: string; reason: string }) => input)
  .handler(async ({ data }) => cancelSubscriptionById(data.subscriptionId, data.reason));

/** Every email the office has sent to a customer, and whether it arrived. */
export const getCustomerNotices = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => listCustomerNotices());

/**
 * Redrive abandoned work.
 *
 * A task that exhausted its retries waits in the dead-letter queue until
 * somebody looks at it. Redriving is a founder action, never an automatic
 * one, and the item goes back with its attempt count reset.
 */
export const redriveWork = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { workId: string }) => ({ workId: str(input?.workId, 100) }))
  .handler(async ({ data }) => redriveAbandonedWork(data.workId));

// ── Customer quote links ─────────────────────────────────────────────────────

const quoteViewLimiter = createRateLimiter(60, 60 * 60 * 1000);
const quoteAnswerLimiter = createRateLimiter(10, 60 * 60 * 1000);

async function currentRequest(): Promise<Request | undefined> {
  try {
    const server = await import("@tanstack/react-start/server");
    return server.getRequest();
  } catch {
    return undefined;
  }
}

export const listCustomerQuoteLinks = createServerFn({ method: "GET" })
  .middleware([founderMiddleware])
  .handler(async () => listQuoteLinks());

export const createCustomerQuoteLink = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { documentId: string }) => ({ documentId: str(input?.documentId, 100) }))
  .handler(async ({ data }) => createQuoteLink(data.documentId));

export const revokeCustomerQuoteLink = createServerFn({ method: "POST" })
  .middleware([founderMiddleware])
  .validator((input: { documentId: string }) => ({ documentId: str(input?.documentId, 100) }))
  .handler(async ({ data }) => revokeQuoteLinks(data.documentId));

export const getCustomerQuote = createServerFn({ method: "GET" })
  .validator((input: { token: string }) => ({ token: str(input?.token, 100) }))
  .handler(async ({ data }) => {
    if (!plausibleToken(data.token))
      return { ok: false as const, error: "This quote link is not valid. Ask us for a new one." };
    const key = callerKey(await currentRequest());
    if (
      !(await durableAllow(await getSql(), "quote_view", key, 60, 60 * 60 * 1000, Date.now(), () =>
        quoteViewLimiter.allow(key),
      ))
    ) {
      return {
        ok: false as const,
        error: "Too many requests from this connection. Try again in a while.",
      };
    }
    return readPublicQuote(data.token);
  });

export const answerCustomerQuote = createServerFn({ method: "POST" })
  .validator(
    (input: { token: string; outcome: string; name: string; note?: string; agree?: boolean }) =>
      input,
  )
  .handler(async ({ data }) => {
    const token = str(data?.token, 100);
    if (!plausibleToken(token))
      return { ok: false as const, error: "This quote link is not valid. Ask us for a new one." };
    const key = callerKey(await currentRequest());
    if (
      !(await durableAllow(
        await getSql(),
        "quote_answer",
        key,
        10,
        60 * 60 * 1000,
        Date.now(),
        () => quoteAnswerLimiter.allow(key),
      ))
    ) {
      return {
        ok: false as const,
        error: "Too many attempts from this connection. Try again later.",
      };
    }
    const parsed = parseCustomerAnswer({
      outcome: data.outcome,
      name: data.name,
      note: data.note,
      agree: data.agree,
    });
    if (!parsed.ok) return parsed;
    const result = await answerPublicQuote(token, parsed);
    if (!result.ok) return result;
    try {
      const { deliverFounderNotice } = await import("./notify.server");
      await deliverFounderNotice(
        founderQuoteAnswerNotice({
          companyName: result.companyName,
          outcome: parsed.outcome,
          name: parsed.name,
          amountCents: result.amountCents,
          note: parsed.note,
        }),
      );
    } catch {
      // The answer is already recorded.
    }
    return { ok: true as const, outcome: parsed.outcome };
  });

/**
 * Record one real page view. Public, because the beacon comes from a visitor's
 * browser — but it records only what the request already contained, and only
 * for paths the site actually publishes. Rate limited so it cannot be used to
 * fill the table.
 */
export const reportSiteView = createServerFn({ method: "POST" })
  .validator(
    (input: {
      path?: string;
      kind?: string;
      referrer?: string;
      country?: string;
      agentFamily?: string;
    }) => input,
  )
  .handler(async ({ data }) => {
    const { isTrackedPage } = await import("@/lib/site/tracked");
    const path = str(data?.path, 200).split("?")[0].split("#")[0] || "/";
    if (!isTrackedPage(path)) return { ok: true as const, recorded: false };
    let request: Request | undefined;
    try {
      const server = await import("@tanstack/react-start/server");
      request = server.getRequest();
    } catch {
      request = undefined;
    }
    if (!(await allowSiteView(callerKey(request)))) {
      // Silently drop rather than tell a visitor their page view failed.
      return { ok: true as const, recorded: false };
    }
    const { recordSiteEvent } = await import("./office-view.server");
    try {
      await recordSiteEvent({
        kind: str(data.kind, 40) || "page_view",
        path,
        referrer: str(data.referrer, 300) || null,
        country: str(data.country, 80) || null,
        agentFamily: str(data.agentFamily, 300) || null,
      });
      return { ok: true as const, recorded: true };
    } catch {
      return { ok: true as const, recorded: false };
    }
  });

/**
 * Office health for `GET /api/health`.
 *
 * The unauthenticated response is deliberately coarse: enough to tell an
 * operator or a monitor that the business is running, and nothing that leaks a
 * secret, a customer, or internal detail. The founder session upgrades it to the
 * full picture, which is why this uses `officeAccessMiddleware` (which resolves
 * the founder without throwing) rather than `founderMiddleware`.
 */
export const getOfficeHealth = createServerFn({ method: "GET" })
  .middleware([officeAccessMiddleware])
  .handler(async ({ context }): Promise<OfficeHealth> => {
    const { officeHealth } = await import("./health.server");
    return officeHealth({ full: context.founder === true });
  });

/**
 * Health for a plain server route such as `/api/health`.
 *
 * Route handlers are bundled for the client environment too, so they cannot
 * import a `*.server` module directly. This server function does the founder
 * and cron-secret check inside the server graph and returns the scope with the
 * document, allowing the route to project the public view without ever
 * importing auth internals.
 */
export const getOfficeHealthForRequest = createServerFn({ method: "GET" })
  .validator((input: { token?: string }) => ({ token: str(input?.token, 4096) }))
  .handler(async ({ data }): Promise<{ full: boolean; health: OfficeHealth }> => {
    const { officeHealth } = await import("./health.server");
    let full = false;
    const configured = process.env.CRON_SECRET?.trim() ?? "";
    if (data.token && configured) {
      const { createHash, timingSafeEqual } = await import("node:crypto");
      const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
      full = timingSafeEqual(digest(data.token), digest(configured));
    }
    if (!full) full = await isFounderToken(data.token || undefined);
    return { full, health: await officeHealth({ full }) };
  });

/**
 * The public status document for `/status`.
 *
 * The full health read happens on the server and is immediately reduced to the
 * five fields the public page shows. Money, the halt reason, customer counts,
 * mail configuration and delegation limits never cross this boundary.
 */
export const getPublicStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { officeHealth } = await import("./health.server");
  const health = await officeHealth();
  return publicStatus({
    checkedAt: health.checkedAt,
    company: health.company,
    version: health.version,
    halted: health.halted,
    database: { ok: health.database.ok },
    chain: { ok: health.chain.ok },
    scheduler: {
      autonomyEnabled: health.scheduler.autonomyEnabled,
      overdue: health.scheduler.overdue,
      consecutiveFailures: health.scheduler.consecutiveFailures,
    },
    rateCard: { ok: health.rateCard.ok },
  });
});
