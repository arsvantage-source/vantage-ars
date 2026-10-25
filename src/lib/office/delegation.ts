/**
 * Delegated authority.
 *
 * The constitution reserves four things to the founder: anything that costs
 * money, anything that might win a customer, anything that might lose one, and
 * every marketing-to-sales handoff. That is the right default, and it is the
 * reason the office cannot run a business on its own.
 *
 * A delegation is the founder saying, in advance and in writing: "for this
 * bounded class of action, at this price, up to this many times a day, you may
 * act without asking me again." It does not weaken the constitution — it is the
 * mechanism ART-12 always implied: a founder gate that the founder can satisfy
 * once, in advance, for a class of action, instead of once per action.
 *
 * Everything about a delegation is deliberately boring:
 *   - it names the action kinds it covers, from a fixed list;
 *   - it names the published rate lines it may charge;
 *   - it caps the amount of any single action;
 *   - it caps how many actions it may take per day and per month;
 *   - it can be paused or revoked by the founder at any moment, and revocation
 *     takes effect on the very next action.
 *
 * A delegation never overrides a hard block. It cannot make an agent act
 * outside its role, cannot permit a promise to a customer, cannot permit a
 * price that is not on the published card, and cannot be used to argue with a
 * halt.
 *
 * Pure module: no database, no clock, no environment. Unit tested directly.
 */
import { PUBLISHED_RATES } from "./catalogue";
import { listProducts } from "./products.server";

/**
 * The action kinds a delegation may cover. This list is closed on purpose: a
 * delegation is a promise about a known class of work, not a general licence.
 */
export const DELEGATABLE_ACTIONS = [
  "open_opportunity",
  "issue_quote",
  "propose_close_won",
  "issue_invoice",
  "record_inbound_payment",
  "start_subscription",
  "cancel_subscription",
  "fulfil_service",
  "send_customer_mail",
] as const;

export type DelegationAction = (typeof DELEGATABLE_ACTIONS)[number];

export type DelegationStatus = "active" | "paused" | "revoked";

export type DelegationPolicy = {
  id: string;
  label: string;
  status: DelegationStatus;
  /** The most any single delegated action may be worth, in cents. */
  maxAmountCents: number;
  maxActionsPerDay: number;
  maxActionsPerMonth: number;
  /** Action kinds this delegation covers. */
  allowedActions: DelegationAction[];
  /** Published rate lines the office may charge under this delegation. */
  allowedRateIds: string[];
  /** Whether the office may send a customer email without asking. */
  allowCustomerMail: boolean;
  /** Whether an exact payment notice may be matched to an invoice automatically. */
  allowAutoReconcile: boolean;
  /** Whether the customer must already have an accepted quote on file. */
  requireAcceptedQuote: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type DelegationRequest = {
  action: DelegationAction;
  amountCents: number;
  /** The published rate line being charged, when the action charges for one. */
  rateId: string | null;
  /** Whether the customer has an accepted quote on file. */
  acceptedQuote: boolean;
  /** Whether the customer has a won opportunity on file. */
  opportunityWon: boolean;
  /** Whether this customer actually contacted the office. */
  realEnquiry: boolean;
  /** Delegated actions already taken today. */
  usedToday: number;
  /** Delegated actions already taken this month. */
  usedThisMonth: number;
};

export type DelegationVerdict = {
  allowed: boolean;
  /** The name of the check that decided it, for the audit trace. */
  check: string;
  reason: string;
};

/** Published rate lines that may be delegated. A withheld line never can. */
import { isOfferedProductSync, offeredProductIdsSync } from "./products.server";

export function delegatableRateIds(): string[] {
  const cached = offeredProductIdsSync();
  if (cached.length) return cached;
  return PUBLISHED_RATES.filter((rate) => rate.offered).map((rate) => rate.id);
}

/** Whether a rate line exists, is offered, and may be charged. */
export function isDelegatableRate(rateId: string): boolean {
  if (isOfferedProductSync(rateId)) return true;
  const rate = PUBLISHED_RATES.find((item) => item.id === rateId);
  return Boolean(rate?.offered);
}

function deny(check: string, reason: string): DelegationVerdict {
  return { allowed: false, check, reason };
}

function allow(check: string, reason: string): DelegationVerdict {
  return { allowed: true, check, reason };
}

/**
 * Decide one action against one delegation.
 *
 * The order matters: the cheapest, most absolute refusals come first, so the
 * reason recorded in the audit trail is the real reason rather than the first
 * one to happen to trip.
 */
export function evaluateDelegation(
  policy: DelegationPolicy | null,
  request: DelegationRequest,
): DelegationVerdict {
  if (!policy) {
    return deny(
      "no_delegation",
      "No standing delegation exists. This needs the founder, one action at a time.",
    );
  }
  if (policy.status === "revoked") {
    return deny("revoked", "The delegation was revoked by the founder.");
  }
  if (policy.status === "paused") {
    return deny("paused", "The delegation is paused. The founder has not resumed it.");
  }
  if (!policy.allowedActions.includes(request.action)) {
    return deny("action_not_delegated", `The delegation does not cover ${request.action}.`);
  }
  const amount = Math.max(0, Math.round(request.amountCents || 0));
  if (amount > policy.maxAmountCents) {
    return deny(
      "amount_over_cap",
      `R${(amount / 100).toFixed(2)} is over the delegation's cap of R${(policy.maxAmountCents / 100).toFixed(2)}.`,
    );
  }
  if (policy.maxActionsPerDay > 0 && request.usedToday >= policy.maxActionsPerDay) {
    return deny(
      "daily_cap_reached",
      `The delegation has already been used ${request.usedToday} time(s) today.`,
    );
  }
  if (policy.maxActionsPerMonth > 0 && request.usedThisMonth >= policy.maxActionsPerMonth) {
    return deny(
      "monthly_cap_reached",
      `The delegation has already been used ${request.usedThisMonth} time(s) this month.`,
    );
  }
  if (request.rateId) {
    if (!isDelegatableRate(request.rateId)) {
      return deny(
        "rate_not_published",
        `${request.rateId} is not an offered published rate, so it cannot be delegated.`,
      );
    }
    if (!policy.allowedRateIds.includes(request.rateId)) {
      return deny(
        "rate_not_delegated",
        `The delegation does not cover the ${request.rateId} rate line.`,
      );
    }
  }
  if (
    policy.requireAcceptedQuote &&
    ACCEPTED_QUOTE_GATED.has(request.action) &&
    !request.acceptedQuote
  ) {
    return deny(
      "no_accepted_quote",
      "The delegation only applies to customers with an accepted quote on file.",
    );
  }
  if (MONEY_ACTIONS.has(request.action) && !request.acceptedQuote && !request.opportunityWon) {
    return deny(
      "no_won_work",
      "The office may only charge a customer for work they have accepted.",
    );
  }
  if (SELLING_ACTIONS.has(request.action) && !request.realEnquiry) {
    return deny(
      "no_real_enquiry",
      "The office may only sell under a delegation to a customer who actually contacted us.",
    );
  }
  if (request.action === "send_customer_mail" && !policy.allowCustomerMail) {
    return deny("mail_not_delegated", "The delegation does not allow customer email.");
  }
  return allow("delegated", `Acted under the delegation "${policy.label}".`);
}

/** Actions that put a commercial offer in front of a customer. */
const SELLING_ACTIONS = new Set<DelegationAction>([
  "open_opportunity",
  "issue_quote",
  "propose_close_won",
]);

/** Actions that put money on an account. They always need work that was won. */
const MONEY_ACTIONS = new Set<DelegationAction>([
  "issue_invoice",
  "record_inbound_payment",
  "start_subscription",
]);

/**
 * Actions that can only be taken for work the customer has already accepted.
 *
 * A policy's "accepted quote required" switch protects the money and delivery
 * side of the office. It cannot apply to opening an opportunity or issuing the
 * first quote, because those happen before an accepted quote can exist. Those
 * actions are still gated by the real-enquiry rule and the publish-price rule.
 */
const ACCEPTED_QUOTE_GATED = new Set<DelegationAction>([
  ...MONEY_ACTIONS,
  "propose_close_won",
  "fulfil_service",
  "cancel_subscription",
]);

/** The next day's usage is not the next action's problem; this resets counters. */
export function delegationUsageKey(now: Date = new Date()): { day: string; month: string } {
  return {
    day: now.toISOString().slice(0, 10),
    month: now.toISOString().slice(0, 7),
  };
}

export type DelegationPreset = {
  id: string;
  label: string;
  summary: string;
  allowedActions: DelegationAction[];
  allowCustomerMail: boolean;
  allowAutoReconcile: boolean;
  requireAcceptedQuote: boolean;
};

/**
 * Starting points the founder can choose from. None of them inserts itself.
 * The founder turns one on, and can pause or revoke it on the next action.
 */
export const DELEGATION_PRESETS: DelegationPreset[] = [
  {
    id: "observe",
    label: "Observe only",
    summary: "No delegated actions. Everything still stops at the founder gate.",
    allowedActions: [],
    allowCustomerMail: false,
    allowAutoReconcile: false,
    requireAcceptedQuote: true,
  },
  {
    id: "delivery",
    label: "Deliver and tell the customer",
    summary:
      "The office may fulfil a productised service and email the customer the report. No selling, no money.",
    allowedActions: ["fulfil_service", "send_customer_mail"],
    allowCustomerMail: true,
    allowAutoReconcile: false,
    requireAcceptedQuote: true,
  },
  {
    id: "billing",
    label: "Bill and collect",
    summary:
      "The office may invoice an accepted customer, email the invoice, and match an exact payment to it.",
    allowedActions: ["issue_invoice", "record_inbound_payment", "send_customer_mail"],
    allowCustomerMail: true,
    allowAutoReconcile: true,
    requireAcceptedQuote: true,
  },
  {
    id: "revenue",
    label: "Managed revenue",
    summary:
      "Everything above, plus selling the published managed plans to a real enquiry, starting a subscription, and ending one.",
    allowedActions: [
      "open_opportunity",
      "issue_quote",
      "issue_invoice",
      "record_inbound_payment",
      "start_subscription",
      "cancel_subscription",
      "fulfil_service",
      "send_customer_mail",
    ],
    allowCustomerMail: true,
    allowAutoReconcile: true,
    requireAcceptedQuote: false,
  },
  {
    id: "unattended",
    label: "Run the desk",
    summary:
      "For a customer who actually wrote in, the office may open the sale, quote a published rate, and email them. After they accept, it may mark the work won, invoice, match an exact payment, start a published subscription, and send the report. It cannot end a subscription, spend money, or pay the founder. Over the cap, it waits.",
    allowedActions: [
      "open_opportunity",
      "issue_quote",
      "propose_close_won",
      "issue_invoice",
      "record_inbound_payment",
      "start_subscription",
      "fulfil_service",
      "send_customer_mail",
    ],
    allowCustomerMail: true,
    allowAutoReconcile: true,
    requireAcceptedQuote: true,
  },
];

/** A blank policy for the founder to fill in. Nothing is on until they do. */
export function blankDelegation(label = "Untitled delegation"): DelegationPolicy {
  const now = new Date().toISOString();
  return {
    id: "",
    label,
    status: "active",
    maxAmountCents: 500000,
    maxActionsPerDay: 20,
    maxActionsPerMonth: 200,
    allowedActions: [],
    allowedRateIds: delegatableRateIds(),
    allowCustomerMail: false,
    allowAutoReconcile: false,
    requireAcceptedQuote: true,
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  };
}
