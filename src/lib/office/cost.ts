/**
 * Cost governance: the office's envelope, enforced before a call is made.
 *
 * An autonomous office that cannot say no to an expensive call is not
 * autonomous, it is expensive. This module holds the envelope: four nested
 * budgets that are checked *before* the model is called, so a refusal costs
 * nothing and a runaway loop is stopped at the door rather than in the bank
 * account at the end of the month.
 *
 * The four levels, checked in this order, narrowest first:
 *
 *   - **capsule** — the single call being admitted. A capsule is the smallest
 *     unit of work the office buys, so one call may not cost more than the
 *     capsule ceiling on its own.
 *   - **fire** — everything spent since the agent's last fire. A fire is one
 *     run of one duty; an agent that burns its whole budget in one tick must
 *     be stopped before it starts again.
 *   - **daily** — everything spent today, across every agent and every duty.
 *   - **monthly** — everything spent this calendar month.
 *
 * The first level whose projected spend would exceed its ceiling refuses the
 * call, so the tightest scope is always the one named. The refusal carries the
 * arithmetic — the limit, the spend so far, the projection and the shortfall —
 * because a governance decision that cannot be checked is just an opinion.
 *
 * Deliberately does not: read a clock, read a database, keep any counter of
 * its own, or make the call. It decides whether a call may be made; making it
 * and paying for it is somebody else's job.
 */

export type BudgetLevel = "capsule" | "fire" | "daily" | "monthly";

/** The budget levels, in the order they are checked. Narrowest first. */
export const BUDGET_LEVELS: readonly BudgetLevel[] = ["capsule", "fire", "daily", "monthly"];

export type BudgetRule = { level: BudgetLevel; ceilingCents: number };

export type CostEstimate = { inputTokens: number; outputTokens: number };

export type BudgetState = {
  spentTodayCents: number;
  spentThisMonthCents: number;
  spentThisFireCents: number;
  /** The number of calls already made this fire. */
  callsThisFire: number;
  callsToday: number;
  callsThisMonth: number;
};

export type AdmissionVerdict = {
  admitted: boolean;
  reason: string;
  /** The arithmetic, for the refusal message. */
  arithmetic: {
    limitCents: number;
    spentCents: number;
    projectedCents: number;
    shortfallCents: number;
  };
  /** The level that refused, or null when the call was admitted. */
  level: BudgetLevel | null;
};

/** The default envelope, in cents. */
export const CAPSULE_BUDGET_CENTS = 200;
export const FIRE_BUDGET_CENTS = 1500;
export const DAILY_BUDGET_CENTS = 12000;
export const MONTHLY_BUDGET_CENTS = 250000;

/** Token prices are quoted per million tokens. */
const TOKENS_PER_PRICE_UNIT = 1_000_000;

// ── The envelope ──────────────────────────────────────────────────────────────

/**
 * The default budget rules, in the order they are checked.
 *
 * A fresh array every call, so a caller that edits the envelope cannot edit
 * the office's.
 */
export function budgetRules(): BudgetRule[] {
  return [
    { level: "capsule", ceilingCents: CAPSULE_BUDGET_CENTS },
    { level: "fire", ceilingCents: FIRE_BUDGET_CENTS },
    { level: "daily", ceilingCents: DAILY_BUDGET_CENTS },
    { level: "monthly", ceilingCents: MONTHLY_BUDGET_CENTS },
  ];
}

/**
 * Build the budget rules from founder-controlled ceilings. A level that is
 * missing falls back to the documented default, so a fresh office keeps its
 * original envelope until the founder chooses otherwise.
 */
export function budgetRulesFromCeilings(ceilings: Record<string, number>): BudgetRule[] {
  return [
    { level: "capsule", ceilingCents: ceilings.capsule ?? CAPSULE_BUDGET_CENTS },
    { level: "fire", ceilingCents: ceilings.fire ?? FIRE_BUDGET_CENTS },
    { level: "daily", ceilingCents: ceilings.daily ?? DAILY_BUDGET_CENTS },
    { level: "monthly", ceilingCents: ceilings.monthly ?? MONTHLY_BUDGET_CENTS },
  ];
}

// ── Cost arithmetic ───────────────────────────────────────────────────────────

/**
 * The cost of a call, in cents.
 *
 * The rate is quoted per million tokens, so the arithmetic is done in whole
 * units and only then divided — never in floating point, which would let a
 * fraction of a cent round in the office's favour. The result is rounded UP:
 * the budget must never be under-charged, because a cent that is quietly not
 * counted is a cent the office will spend a hundred times over.
 */
export function estimateCost(
  estimate: CostEstimate,
  rateCentsPerMillion: { input: number; output: number },
): number {
  const inputTokens = Math.max(0, Math.trunc(estimate.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(estimate.outputTokens));
  const inputRate = Math.max(0, Math.trunc(rateCentsPerMillion.input));
  const outputRate = Math.max(0, Math.trunc(rateCentsPerMillion.output));
  const numerator = inputTokens * inputRate + outputTokens * outputRate;
  if (numerator <= 0) return 0;
  return Math.floor((numerator + TOKENS_PER_PRICE_UNIT - 1) / TOKENS_PER_PRICE_UNIT);
}

// ── Admission ─────────────────────────────────────────────────────────────────

/** The spend so far at one level. The capsule is the call itself. */
function spentAt(level: BudgetLevel, state: BudgetState): number {
  switch (level) {
    case "capsule":
      return 0;
    case "fire":
      return state.spentThisFireCents;
    case "daily":
      return state.spentTodayCents;
    case "monthly":
      return state.spentThisMonthCents;
    default:
      return 0;
  }
}

/**
 * Decide whether a call may be made.
 *
 * The levels are checked narrowest first and the first one that would be
 * exceeded refuses the call. A level with **no rule** is unlimited: the
 * envelope is what the office has agreed to spend, and a missing rule means
 * that scope was never agreed. A level with a rule whose ceiling is **zero** is
 * a hard zero: nothing at all may be spent at that level. The two are
 * deliberately different — "unlimited" and "nothing" must never be confused.
 *
 * The call counts in the state are carried for callers that report them; the
 * envelope itself is expressed in cents, so admission is decided on spend.
 */
export function admit(
  rules: BudgetRule[],
  estimate: CostEstimate,
  rate: { input: number; output: number },
  state: BudgetState,
): AdmissionVerdict {
  const costCents = estimateCost(estimate, rate);

  const ceilings = new Map<BudgetLevel, number>();
  for (const rule of rules) ceilings.set(rule.level, rule.ceilingCents);

  for (const level of BUDGET_LEVELS) {
    const limit = ceilings.get(level);
    if (limit === undefined) continue; // no rule at this level means no limit here
    const spent = spentAt(level, state);
    const projected = spent + costCents;
    if (projected <= limit) continue;
    const shortfall = Math.max(0, projected - limit);
    return {
      admitted: false,
      reason: `Refused: the ${level} budget would be exceeded by ${shortfall} cents.`,
      arithmetic: {
        limitCents: limit,
        spentCents: spent,
        projectedCents: projected,
        shortfallCents: shortfall,
      },
      level,
    };
  }

  return {
    admitted: true,
    reason: "Admitted: the call fits every budget level.",
    arithmetic: {
      limitCents: 0,
      spentCents: 0,
      projectedCents: costCents,
      shortfallCents: 0,
    },
    level: null,
  };
}

// ── The metric that matters ───────────────────────────────────────────────────

/**
 * Cost per completed task.
 *
 * The point of this metric is cost per task, not cost per token: a task that
 * was retried three times and finally completed cost all three attempts, so
 * the task's whole cost is divided by the number of *completed* attempts it
 * took. An attempt that did not complete carries no completed-task cost and
 * says so with a zero, and a task that never completed has no cost per
 * completed task at all — also a zero, rather than a flattering average.
 */
export function costPerTask(
  spans: { taskId: string; costCents: number; completed: boolean }[],
): { taskId: string; costCents: number; completed: boolean; costPerCompletedTaskCents: number }[] {
  const costByTask = new Map<string, number>();
  const completionsByTask = new Map<string, number>();
  for (const span of spans) {
    costByTask.set(span.taskId, (costByTask.get(span.taskId) ?? 0) + span.costCents);
    if (span.completed) {
      completionsByTask.set(span.taskId, (completionsByTask.get(span.taskId) ?? 0) + 1);
    }
  }

  const perTask = new Map<string, number>();
  for (const [taskId, costCents] of costByTask) {
    const completions = completionsByTask.get(taskId) ?? 0;
    perTask.set(taskId, completions > 0 ? Math.round(costCents / completions) : 0);
  }

  return spans.map((span) => ({
    taskId: span.taskId,
    costCents: span.costCents,
    completed: span.completed,
    costPerCompletedTaskCents: span.completed ? (perTask.get(span.taskId) ?? 0) : 0,
  }));
}

// ── Saying no ─────────────────────────────────────────────────────────────────

/**
 * The refusal message.
 *
 * It carries the arithmetic and nothing else: no prompt, no model name, no
 * token counts, no internal detail. This is the body the office hands back
 * when it refuses to spend, and it must be safe to show to anyone.
 */
export function formatRefusal(verdict: AdmissionVerdict): string {
  if (verdict.admitted) {
    return `No refusal. This call projects ${verdict.arithmetic.projectedCents} cents and fits every budget level.`;
  }
  const { limitCents, spentCents, projectedCents, shortfallCents } = verdict.arithmetic;
  const level = verdict.level ?? "budget";
  return (
    `Refused at the ${level} budget. The limit is ${limitCents} cents, ` +
    `${spentCents} cents have been spent, and this call would project ` +
    `${projectedCents} cents — ${shortfallCents} cents over the limit. ` +
    `The call was not made.`
  );
}
