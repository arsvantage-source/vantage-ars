import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "../db";
import { AGENT_DEFS, AGENT_BY_ID } from "./agents";
import { CONSTITUTION } from "./constitution";
import { COMPANY, GENESIS_HASH } from "./company";
import { seedProductsIfEmpty } from "./products.server";
import { authorizeAction } from "./governor";
import { chainHash, sha256Hex, stableStringify } from "./hash";
import { assessRisk, type RiskAssessment, type RiskTier, type RiskTierName } from "./risk";
import {
  REASON_CODES,
  requiresPreExposureReasoning,
  runGate71,
  validatePreExposureReasoning,
  type GateAnswer,
  type GateOutcome,
  type GateQuestion,
} from "./gate71";
import {
  amountBand,
  precedentAdvice,
  retrievePrecedent,
  type DecisionEpisode,
  type PrecedentMatch,
} from "./precedent";
import { PUBLISHED_RATES } from "./catalogue";
import { buildQuoteDocument } from "./quote";
import {
  DELEGATABLE_ACTIONS,
  delegatableRateIds,
  type DelegationAction,
  type DelegationPolicy,
} from "./delegation";
import { planById } from "./plans";
import { nextCycleStart } from "./subscription";
import {
  buildCustomerBook,
  type CustomerActivity,
  type CustomerActivitySource,
  type CustomerBook,
  type CustomerLedgerRow,
  type CustomerPlanRow,
} from "./customers";
import { resolveRecipient } from "./customer-notice.server";
import { summarizeSiteSignals, type SiteSignals } from "./site-signals";
import {
  customerQuoteText,
  deliveryJob,
  documentRef,
  invoiceCopy,
  ledgerVat,
  parseVatTreatment,
  type VatTreatment,
  expenseVat,
  paymentInstructionsText,
  paymentNote,
  quoteInvoice,
  receiptCopy,
  receiptForInvoice,
} from "./invoice";
import { parsePaymentNotice } from "./payment-notice";
import { nextTicketStatus } from "./ticket";
import {
  linkExpiry,
  linkState,
  plausibleToken,
  type QuoteLinkState,
  type QuoteLinkSummary,
} from "./quote-link";
import { smtpStatus } from "./smtp.server";
import type {
  ActionKind,
  AgentDef,
  AgentRow,
  ApprovalKind,
  ApprovalRow,
  AuditRow,
  AutonomyHealth,
  BillingCycleRow,
  CampaignRow,
  CompanySnapshot,
  DecisionRow,
  DelegationUsage,
  DispatchResult,
  DocumentRow,
  InboundRow,
  LeadRow,
  LedgerRow,
  NoticeRow,
  OfficeSnapshot,
  OpportunityRow,
  ProposedAction,
  ProvisionCheck,
  ProvisionRow,
  Reversibility,
  RevenueMetrics,
  ServiceTimeRow,
  SubscriptionRow,
  TicketRow,
  Json,
} from "./types";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return new Date().toISOString();
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function bool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === "object") return value as T;
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * The audit hash chain is a single shared pointer in `company_state`. Two
 * concurrent writers that both read the old head and both write a child fork
 * the chain permanently, and the existing "head matches newest row" check cannot
 * see the fork. So every chain write — decisions AND audit events — happens
 * inside one transaction holding a named advisory lock, and reads the head back
 * with `for update` so a row lock backs the advisory lock.
 */
const CHAIN_LOCK = "vantage-ars:audit-chain";

async function withChain<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  const sql = await getSql();
  return sql.advisory(CHAIN_LOCK, body);
}

async function readAuditHead(sql: Sql): Promise<string> {
  const rows = await sql<{ last_audit_hash: string }>`
    select last_audit_hash from company_state where id = ${COMPANY.id} for update
  `;
  const head = rows[0]?.last_audit_hash;
  if (!head) throw new Error("Office is not provisioned.");
  return head;
}

async function appendAuditTx(
  sql: Sql,
  kind: string,
  title: string,
  body: string,
  actor: string,
): Promise<string> {
  const previous = await readAuditHead(sql);
  const id = randomUUID();
  const recordHash = chainHash(previous, { id, kind, title, body, actor });
  await sql`
    insert into audit_events (id, kind, title, body, actor, previous_hash, record_hash)
    values (${id}, ${kind}, ${title}, ${body}, ${actor}, ${previous}, ${recordHash})
  `;
  await sql`
    update company_state
    set last_audit_hash = ${recordHash}, updated_at = now()
    where id = ${COMPANY.id}
  `;
  return recordHash;
}

/**
 * Record an event on the audit chain, taking the chain lock. Exported for the
 * scheduler, which runs outside the action path and must still be chained.
 */
export async function appendAudit(
  kind: string,
  title: string,
  body: string,
  actor: string,
): Promise<string> {
  return withChain((tx) => appendAuditTx(tx, kind, title, body, actor));
}

async function loadCompany(): Promise<CompanySnapshot> {
  return loadCompanyTx(await getSql());
}

async function loadCompanyTx(sql: Sql): Promise<CompanySnapshot> {
  const rows = await sql<Record<string, unknown>>`
    select * from company_state where id = ${COMPANY.id} limit 1
  `;
  const row = rows[0];
  if (!row) throw new Error("Office is not provisioned.");
  return {
    id: String(row.id),
    legalName: String(row.legal_name),
    tradingName: String(row.trading_name),
    domain: String(row.domain),
    jurisdiction: String(row.jurisdiction),
    timezone: String(row.timezone),
    currency: String(row.currency),
    vatRate: num(row.vat_rate, 0.15),
    authorName: String(row.author_name),
    authorRole: String(row.author_role),
    constitutionVersion: String(row.constitution_version),
    treasuryCents: num(row.treasury_cents),
    receivableCents: num(row.receivable_cents),
    payableCents: num(row.payable_cents),
    autonomyLevel: "A3",
    halted: bool(row.halted),
    haltReason: row.halt_reason ? String(row.halt_reason) : null,
    paymentInstructions: row.payment_instructions ? String(row.payment_instructions) : "",
    lastAuditHash: String(row.last_audit_hash),
    openedAt: iso(row.opened_at),
    updatedAt: iso(row.updated_at),
  };
}

function quoteDocumentBody(quoteId: string, action: ProposedAction): string {
  const document = buildQuoteDocument({
    rateId: action.payload.rateId,
    location: action.payload.location,
    quantity: action.payload.quantity,
    amountCents: Math.max(0, Math.round(action.amountCents || 0)),
    reference: documentRef(quoteId),
    scope: action.payload.scope,
  });
  if (!document.ok) throw new Error(`Quote refused: ${document.error}`);
  return document.body;
}

/**
 * Cash may only retire money owed. Never credit more than the outstanding
 * receivable, and never credit at all when nothing is outstanding. Returns the
 * amount actually applied.
 */
async function applyReceiptAgainstReceivable(sql: Sql, amount: number): Promise<number> {
  if (amount <= 0) return 0;
  const rows = await sql<{ receivable_cents: number }>`
    select receivable_cents from company_state where id = ${COMPANY.id} for update
  `;
  const outstanding = Math.max(0, num(rows[0]?.receivable_cents));
  const applied = Math.min(amount, outstanding);
  if (applied <= 0) return 0;
  await sql`
    update company_state
    set treasury_cents = treasury_cents + ${applied},
        receivable_cents = receivable_cents - ${applied},
        updated_at = now()
    where id = ${COMPANY.id}
  `;
  return applied;
}

/**
 * Provision the office if it is not there yet, and converge the roster.
 *
 * Runs at most once per process: `readSnapshot` used to call this on every page
 * load, which meant nine pointless `UPDATE agents` statements (each taking a row
 * lock and bloating `xmin`) on every office render and every public quote-link
 * view. Callers still get a correct roster because convergence is cheap and
 * idempotent once the flag is set.
 */
let provisionPromise: Promise<void> | null = null;

export function ensureOffice(): Promise<void> {
  provisionPromise ??= provisionOffice().catch((err) => {
    provisionPromise = null; // let the next caller retry
    throw err;
  });
  return provisionPromise;
}

async function provisionOffice(): Promise<void> {
  const sql = await getSql();
  const existing = await sql<{ id: string }>`select id from company_state where id = ${COMPANY.id}`;
  if (existing.length) {
    await syncRoster(sql);
    await seedPaymentInstructions(sql);
    await seedProductsIfEmpty();
    return;
  }

  await sql.transaction(async (tx) => {
    const raced = await tx<{
      id: string;
    }>`select id from company_state where id = ${COMPANY.id} for update`;
    if (raced.length) return;

    await tx`
      insert into company_state (
        id, legal_name, trading_name, domain, jurisdiction, timezone, currency, vat_rate,
        author_name, author_role, constitution_version, treasury_cents, receivable_cents,
        payable_cents, autonomy_level, halted, last_audit_hash, payment_instructions
      ) values (
        ${COMPANY.id}, ${COMPANY.legalName}, ${COMPANY.tradingName}, ${COMPANY.domain},
        ${COMPANY.jurisdiction}, ${COMPANY.timezone}, ${COMPANY.currency}, ${COMPANY.vatRate},
        ${COMPANY.authorName}, ${COMPANY.authorRole}, ${COMPANY.constitutionVersion},
        0, 0, 0, ${COMPANY.autonomyLevel}, false, ${GENESIS_HASH},
        ${paymentInstructionsText(process.env)}
      )
    `;

    for (const p of CONSTITUTION) {
      await tx`
        insert into constitution_provisions (
          id, article_id, title, priority, body, enforcement, machine_checkable, parameters_json
        ) values (
          ${p.id}, ${p.articleId}, ${p.title}, ${p.priority}, ${p.body}, ${p.enforcement},
          ${p.machineCheckable}, ${JSON.stringify(p.parameters)}
        )
      `;
    }

    for (const a of AGENT_DEFS) {
      await insertAgent(tx, a);
    }

    // The genesis audit row is written inside the same transaction so a
    // provisioned office is never missing its founding record.
    const previous = GENESIS_HASH;
    const id = randomUUID();
    const body =
      "Constitution v1.1.0 ratified by Juan-louw Greyling. Nine non-human identities issued. Treasury R0.00. Autonomy A3 within role; founder gates on cost, customer win, customer loss, and marketing-to-sales handoff, with a standing delegation available under ART-13.";
    const recordHash = chainHash(previous, {
      id,
      kind: "office_open",
      title: "Office provisioned",
      body,
      actor: "constitution",
    });
    await tx`
      insert into audit_events (id, kind, title, body, actor, previous_hash, record_hash)
      values (${id}, 'office_open', 'Office provisioned', ${body}, 'constitution', ${previous}, ${recordHash})
    `;
    await tx`
      update company_state set last_audit_hash = ${recordHash}, updated_at = now()
      where id = ${COMPANY.id}
    `;
  });

  await seedPaymentInstructions(sql);
}

/**
 * Fill in the derived bank details exactly once, when the office is created.
 * Previously this ran on every `readSnapshot` and overwrote any payment note the
 * founder had typed, because the match test was a `LIKE` on the rendered text.
 */
async function seedPaymentInstructions(sql: Sql): Promise<void> {
  const derived = paymentInstructionsText(process.env);
  if (!derived) return;
  await sql`
    update company_state
    set payment_instructions = ${derived}
    where id = ${COMPANY.id} and coalesce(payment_instructions, '') = ''
  `;
}

async function insertAgent(sql: Sql, a: AgentDef): Promise<void> {
  await sql`
    insert into agents (
      id, callsign, title, department, spiffe_id, status, autonomy_level, summary,
      allowed_actions_json, bindings_json, authority_json, current_task, last_heartbeat
    ) values (
      ${a.id}, ${a.callsign}, ${a.title}, ${a.department}, ${a.spiffeId}, 'idle',
      ${a.autonomyLevel}, ${a.summary}, ${JSON.stringify(a.allowedActions)},
      ${JSON.stringify(a.bindings)}, ${JSON.stringify(a.authority)}, null, now()
    )
    on conflict (id) do nothing
  `;
}

async function syncRoster(sql: Sql): Promise<void> {
  const rows = await sql<{ id: string }>`select id from agents`;
  const have = new Set(rows.map((row) => String(row.id)));
  for (const agent of AGENT_DEFS) {
    if (have.has(agent.id)) continue;
    await insertAgent(sql, agent);
    await appendAudit(
      "identity_issued",
      `${agent.callsign} issued`,
      `${agent.title} joined the floor. ${agent.summary}`,
      "constitution",
    );
  }
  // One statement instead of nine, and only when something actually drifted.
  const stale = AGENT_DEFS.filter((agent) => agent.summary.length > 0);
  for (const agent of stale) {
    await sql`
      update agents set summary = ${agent.summary}, authority_json = ${JSON.stringify(agent.authority)}
      where id = ${agent.id} and (summary <> ${agent.summary} or authority_json <> ${JSON.stringify(agent.authority)})
    `;
  }
  const role = CONSTITUTION.find((provision) => provision.id === "art-11");
  if (role) {
    await sql`
      update constitution_provisions
      set body = ${role.body}
      where id = ${"art-11"} and body is distinct from ${role.body}
    `;
  }
  // A constitution amendment must reach an office that was provisioned before
  // it. Every provision is re-synced, so a deployed office is never running a
  // constitution that is one version behind the code.
  for (const provision of CONSTITUTION) {
    await sql`
      update constitution_provisions
      set body = ${provision.body},
          title = ${provision.title},
          priority = ${provision.priority}
      where id = ${provision.id}
        and (body is distinct from ${provision.body}
             or title is distinct from ${provision.title}
             or priority is distinct from ${provision.priority})
    `;
  }
}

function mapAgent(row: Record<string, unknown>): AgentRow {
  const def = AGENT_BY_ID[String(row.id)];
  return {
    id: String(row.id),
    callsign: String(row.callsign),
    title: String(row.title),
    department: String(row.department),
    spiffeId: String(row.spiffe_id),
    status: (String(row.status) as AgentRow["status"]) || "idle",
    autonomyLevel: "A3",
    summary: String(row.summary),
    allowedActions: parseJson(row.allowed_actions_json, def?.allowedActions ?? []),
    bindings: parseJson(row.bindings_json, def?.bindings ?? []),
    authority: parseJson(
      row.authority_json,
      def?.authority ?? {
        maySpend: false,
        mayContactMarket: false,
        mayEnterSales: false,
        mayIssueInvoice: false,
        mayHaltFleet: false,
        vetoPower: false,
        maxAutonomousCents: 0,
      },
    ),
    currentTask: row.current_task ? String(row.current_task) : null,
    lastHeartbeat: row.last_heartbeat ? iso(row.last_heartbeat) : null,
    decisionsCount: num(row.decisions_count),
    escalationsCount: num(row.escalations_count),
  };
}

function mapApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: String(row.id),
    kind: row.kind as ApprovalRow["kind"],
    title: String(row.title),
    rationale: String(row.rationale),
    amountCents: num(row.amount_cents),
    agentId: String(row.agent_id),
    companyName: row.company_name ? String(row.company_name) : null,
    status: row.status as ApprovalRow["status"],
    riskScore: num(row.risk_score),
    constitutionalTrace: parseJson(row.constitutional_trace_json, []),
    action: parseJson(row.action_json, {
      kind: "notify_operator",
      title: "",
      rationale: "",
      confidence: 0,
      amountCents: 0,
      payload: {},
    }),
    resolutionNote: row.resolution_note ? String(row.resolution_note) : null,
    createdAt: iso(row.created_at),
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
  };
}

function mapDecision(row: Record<string, unknown>): DecisionRow {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    actionKind: String(row.action_kind),
    title: String(row.title),
    rationale: String(row.rationale),
    status: row.status as DecisionRow["status"],
    confidence: num(row.confidence),
    reversibility: row.reversibility as DecisionRow["reversibility"],
    amountCents: num(row.amount_cents),
    constitutionalTrace: parseJson(row.constitutional_trace_json, []),
    observation: parseJson(row.observation_json, {}),
    action: parseJson(row.action_json, {}),
    evidenceHash: String(row.evidence_hash),
    previousHash: String(row.previous_hash),
    recordHash: String(row.record_hash),
    createdAt: iso(row.created_at),
  };
}

/**
 * The autonomy health the founder sees on /office/metrics.
 *
 * Previously `hardViolations` was hardcoded to 0, which made
 * `constraintAdherence` a constant 1 — a blocked action was invisible in the
 * headline number. Every term below is now derived from rows that exist.
 */
function healthOf(
  company: CompanySnapshot,
  decisions: DecisionRow[],
  approvals: ApprovalRow[],
): AutonomyHealth {
  const total = decisions.length;
  const blocked = decisions.filter((d) => d.status === "blocked").length;
  const escalated = decisions.filter((d) => d.status === "escalated").length;
  const executed = decisions.filter(
    (d) => d.status === "executed" || d.status === "authorized",
  ).length;
  const pending = approvals.filter((a) => a.status === "pending").length;
  const resolved = approvals.filter((a) => a.status !== "pending").length;
  // A block is the system refusing to act. That is the constitution working, not
  // a failure — but a rising count means an agent keeps trying the same thing.
  const hardViolations = blocked;
  const interventionRate = total === 0 ? 0 : escalated / total;
  const autonomousResolution = total === 0 ? 1 : executed / total;
  // Hard blocks are expected to be rare. Above ~2% the fleet is pushing.
  const constraintAdherence =
    total === 0 ? 1 : Math.max(0, 1 - hardViolations / Math.max(total, 1));
  const decisionQuality = total === 0 ? 1 : Math.max(0, 1 - blocked / Math.max(total, 1));
  const governance = company.halted ? 0.4 : 0.98;
  // Backlog of unresolved founder gates is the one thing that silently rots.
  const selfHealing = pending > 20 ? 0.7 : pending > 8 ? 0.84 : 0.94;
  const overall =
    constraintAdherence * 0.3 +
    decisionQuality * 0.2 +
    governance * 0.2 +
    selfHealing * 0.15 +
    autonomousResolution * 0.15;
  return {
    overall: Number(overall.toFixed(3)),
    decisionQuality: Number(decisionQuality.toFixed(3)),
    constraintAdherence: Number(constraintAdherence.toFixed(3)),
    selfHealing,
    governance,
    interventionRate: Number(interventionRate.toFixed(5)),
    autonomousResolution: Number(autonomousResolution.toFixed(4)),
    decisionCount: total,
    pendingApprovals: pending,
    hardViolations,
    resolvedApprovals: resolved,
  };
}

/**
 * Read the whole office.
 *
 * This is a pure read. It used to run `CREATE TABLE` / `ALTER TABLE ... ADD
 * COLUMN` and an unconditional `UPDATE company_state` on every call, which on a
 * pooled Postgres meant an ACCESS EXCLUSIVE lock convoy on every office page
 * load and a silent overwrite of any payment note the founder had typed. All of
 * that now lives in migrations and in `provisionOffice`.
 */
export async function readSnapshot(): Promise<OfficeSnapshot> {
  await ensureOffice();
  const sql = await getSql();
  const company = await loadCompany();

  const [
    provisionRows,
    agentRows,
    inboundRows,
    leadRows,
    oppRows,
    campaignRows,
    ledgerRows,
    ticketRows,
    docRows,
    approvalRows,
    decisionRows,
    auditRows,
    noticeRows,
  ] = await Promise.all([
    sql<
      Record<string, unknown>
    >`select * from constitution_provisions order by priority, article_id`,
    sql<Record<string, unknown>>`select * from agents order by callsign`,
    sql<Record<string, unknown>>`select * from inbound_items order by created_at desc limit 80`,
    sql<Record<string, unknown>>`select * from leads order by updated_at desc limit 80`,
    sql<Record<string, unknown>>`select * from opportunities order by updated_at desc limit 80`,
    sql<Record<string, unknown>>`select * from campaigns order by created_at desc limit 40`,
    sql<Record<string, unknown>>`select * from ledger_entries order by created_at desc limit 80`,
    sql<Record<string, unknown>>`select * from tickets order by updated_at desc limit 80`,
    sql<Record<string, unknown>>`select * from documents order by created_at desc limit 40`,
    sql<Record<string, unknown>>`select * from approvals order by created_at desc limit 80`,
    sql<Record<string, unknown>>`select * from decisions order by created_at desc limit 80`,
    sql<Record<string, unknown>>`select * from audit_events order by created_at desc limit 80`,
    sql<Record<string, unknown>>`select * from founder_notices order by created_at desc limit 8`,
  ]);

  const provisions: ProvisionRow[] = provisionRows.map((row) => ({
    id: String(row.id),
    articleId: String(row.article_id),
    title: String(row.title),
    priority: num(row.priority),
    body: String(row.body),
    enforcement: row.enforcement as ProvisionRow["enforcement"],
    machineCheckable: bool(row.machine_checkable),
    parameters: parseJson(row.parameters_json, {}),
  }));

  const inbound: InboundRow[] = inboundRows.map((row) => ({
    id: String(row.id),
    channel: String(row.channel),
    companyName: String(row.company_name),
    subject: String(row.subject),
    summary: String(row.summary),
    intent: String(row.intent),
    routedTo: row.routed_to ? String(row.routed_to) : null,
    status: String(row.status),
    createdAt: iso(row.created_at),
  }));

  const leads: LeadRow[] = leadRows.map((row) => ({
    id: String(row.id),
    companyName: String(row.company_name),
    source: String(row.source),
    stage: String(row.stage),
    score: num(row.score),
    summary: String(row.summary),
    inboundId: row.inbound_id ? String(row.inbound_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));

  const opportunities: OpportunityRow[] = oppRows.map((row) => ({
    id: String(row.id),
    leadId: String(row.lead_id),
    companyName: String(row.company_name),
    stage: String(row.stage),
    valueCents: num(row.value_cents),
    summary: String(row.summary),
    handoffApprovalId: row.handoff_approval_id ? String(row.handoff_approval_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));

  const campaigns: CampaignRow[] = campaignRows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    channel: String(row.channel),
    status: String(row.status),
    budgetCents: num(row.budget_cents),
    spendCents: num(row.spend_cents),
    summary: String(row.summary),
    createdAt: iso(row.created_at),
  }));

  const ledger: LedgerRow[] = ledgerRows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    counterparty: String(row.counterparty),
    amountCents: num(row.amount_cents),
    vatCents: num(row.vat_cents),
    status: String(row.status),
    memo: String(row.memo),
    relatedId: row.related_id ? String(row.related_id) : null,
    createdAt: iso(row.created_at),
  }));

  const tickets: TicketRow[] = ticketRows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    severity: String(row.severity),
    status: String(row.status),
    ownerAgent: String(row.owner_agent),
    summary: String(row.summary),
    relatedId: row.related_id ? String(row.related_id) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));

  const documents: DocumentRow[] = docRows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    kind: String(row.kind),
    status: String(row.status),
    summary: String(row.summary),
    relatedId: row.related_id ? String(row.related_id) : null,
    createdAt: iso(row.created_at),
  }));

  const approvals = approvalRows.map(mapApproval);
  const decisions = decisionRows.map(mapDecision);
  const audit: AuditRow[] = auditRows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    title: String(row.title),
    body: String(row.body),
    actor: String(row.actor),
    previousHash: String(row.previous_hash),
    recordHash: String(row.record_hash),
    createdAt: iso(row.created_at),
  }));

  const notices: NoticeRow[] = noticeRows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind),
    subject: String(row.subject),
    status: String(row.status) === "sent" ? "sent" : "not_delivered",
    detail: String(row.detail),
    createdAt: iso(row.created_at),
  }));

  const delegation = await readDelegationTx(sql);
  const delegationUsage = delegation
    ? await readDelegationUsageTx(sql, delegation.id)
    : {
        usedToday: 0,
        spentTodayCents: 0,
        usedThisMonth: 0,
        spentThisMonthCents: 0,
      };
  const subscriptionRows = await sql<Record<string, unknown>>`
    select * from subscriptions order by created_at desc limit 200
  `;
  const revenue = await revenueMetrics();

  return {
    company,
    provisions,
    agents: agentRows.map(mapAgent),
    inbound,
    leads,
    opportunities,
    campaigns,
    ledger,
    tickets,
    documents,
    approvals,
    decisions,
    audit,
    notices,
    mail: smtpStatus(),
    health: healthOf(company, decisions, approvals),
    delegation,
    delegationUsage,
    subscriptions: subscriptionRows.map(mapSubscription),
    revenue,
  };
}

async function hasApprovedHandoff(sql: Sql, companyName: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from approvals
    where kind = 'sales_handoff'
      and status = 'approved'
      and lower(coalesce(company_name, '')) = ${companyName.trim().toLowerCase()}
    limit 1
  `;
  return rows.length > 0;
}

async function hasWonOpportunity(sql: Sql, companyName: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from opportunities
    where stage = 'won' and lower(company_name) = ${companyName.trim().toLowerCase()}
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Whether the customer has an accepted quote on file.
 *
 * This is the anchor for delegated billing: the office may only charge a
 * customer for work they have agreed to. It is checked against the whole
 * table, never a window.
 */
async function hasAcceptedQuote(sql: Sql, companyName: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select d.id from documents d
    join opportunities o on o.id = d.related_id
    where d.kind = 'quote'
      and d.status = 'accepted'
      and lower(o.company_name) = ${companyName.trim().toLowerCase()}
    limit 1
  `;
  return rows.length > 0;
}

async function hasWonOpportunityById(sql: Sql, opportunityId: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from opportunities where id = ${opportunityId} and stage = 'won' limit 1
  `;
  return rows.length > 0;
}

async function hasAcceptedQuoteById(sql: Sql, opportunityId: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from documents
    where kind = 'quote' and status = 'accepted' and related_id = ${opportunityId}
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Resolve the opportunity an action is actually about.
 *
 * The governor used to ask only "does this customer have a won job or an
 * accepted quote somewhere?", which let one accepted job authorise an invoice
 * for a different job at the same customer. Follow the action's subject —
 * opportunity, billing cycle, subscription, invoice or quote document — to the
 * opportunity it belongs to, and fall back to the customer check only when the
 * subject cannot be resolved.
 */
async function opportunityIdForAction(sql: Sql, action: ProposedAction): Promise<string | null> {
  const payloadOpportunity =
    typeof action.payload.opportunityId === "string" ? action.payload.opportunityId.trim() : "";
  let candidate =
    payloadOpportunity || (typeof action.relatedId === "string" ? action.relatedId.trim() : "");
  for (let hop = 0; hop < 4 && candidate; hop += 1) {
    const opportunity = await sql<{ id: string }>`
      select id from opportunities where id = ${candidate} limit 1
    `;
    if (opportunity.length) return String(opportunity[0].id);

    const cycle = await sql<{ subscription_id: string }>`
      select subscription_id from billing_cycles where id = ${candidate} limit 1
    `.then((rows) => rows[0]);
    if (cycle?.subscription_id) {
      candidate = String(cycle.subscription_id);
      continue;
    }

    const subscription = await sql<{ opportunity_id: string | null }>`
      select opportunity_id from subscriptions where id = ${candidate} limit 1
    `.then((rows) => rows[0]);
    if (subscription?.opportunity_id) {
      candidate = String(subscription.opportunity_id);
      continue;
    }

    const document = await sql<{ related_id: string | null }>`
      select related_id from documents where id = ${candidate} limit 1
    `.then((rows) => rows[0]);
    if (document?.related_id && document.related_id !== candidate) {
      candidate = String(document.related_id);
      continue;
    }

    const invoice = await sql<{ related_id: string | null }>`
      select related_id from ledger_entries where id = ${candidate} and kind = 'invoice' limit 1
    `.then((rows) => rows[0]);
    if (invoice?.related_id && invoice.related_id !== candidate) {
      candidate = String(invoice.related_id);
      continue;
    }
    break;
  }
  return null;
}

/**
 * Whether this customer actually contacted the office.
 *
 * A lead the office invented from a page view has no inbound record, and the
 * office may not put a commercial offer in front of it — even under a
 * delegation.
 */
async function hasRealEnquiry(sql: Sql, companyName: string): Promise<boolean> {
  const rows = await sql<{ id: string }>`
    select id from inbound_items
    where lower(company_name) = ${companyName.trim().toLowerCase()}
    limit 1
  `;
  return rows.length > 0;
}

// ── Delegated authority ───────────────────────────────────────────────────────

/** There is one delegation. It is edited, paused and revoked, never duplicated. */
const DELEGATION_ID = "primary";

function mapDelegation(row: Record<string, unknown>): DelegationPolicy {
  const actions = parseJson<string[]>(row.allowed_actions_json, []).filter(
    (action): action is DelegationAction =>
      (DELEGATABLE_ACTIONS as readonly string[]).includes(action as string),
  );
  const rates = parseJson<string[]>(row.allowed_rate_ids_json, []).filter((id) =>
    delegatableRateIds().includes(id),
  );
  return {
    id: String(row.id),
    label: String(row.label ?? "Delegation"),
    status: (String(row.status) as DelegationPolicy["status"]) || "active",
    maxAmountCents: num(row.max_amount_cents, 500000),
    maxActionsPerDay: num(row.max_actions_per_day, 20),
    maxActionsPerMonth: num(row.max_actions_per_month, 200),
    allowedActions: actions,
    allowedRateIds: rates,
    allowCustomerMail: bool(row.allow_customer_mail),
    allowAutoReconcile: bool(row.allow_auto_reconcile),
    requireAcceptedQuote: bool(row.require_accepted_quote),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  };
}

async function readDelegationTx(sql: Sql): Promise<DelegationPolicy | null> {
  const rows = await sql<Record<string, unknown>>`
    select * from delegations where id = ${DELEGATION_ID} limit 1
  `;
  return rows.length ? mapDelegation(rows[0]) : null;
}

/** The founder's standing delegation, if there is one. */
export async function readDelegation(): Promise<DelegationPolicy | null> {
  return readDelegationTx(await getSql());
}

/** How much of the delegation has been used. Counted from real rows. */
export async function readDelegationUsage(
  delegationId: string = DELEGATION_ID,
): Promise<DelegationUsage> {
  return readDelegationUsageTx(await getSql(), delegationId);
}

async function readDelegationUsageTx(sql: Sql, delegationId: string): Promise<DelegationUsage> {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  const rows = await sql<{ n: number; cents: number; month_n: number; month_cents: number }>`
    select
      count(*) filter (where usage_day = ${day})::int as n,
      coalesce(sum(amount_cents) filter (where usage_day = ${day}), 0)::int as cents,
      count(*) filter (where usage_month = ${month})::int as month_n,
      coalesce(sum(amount_cents) filter (where usage_month = ${month}), 0)::int as month_cents
    from delegation_usage
    where delegation_id = ${delegationId}
  `;
  const row = rows[0];
  return {
    usedToday: num(row?.n),
    spentTodayCents: num(row?.cents),
    usedThisMonth: num(row?.month_n),
    spentThisMonthCents: num(row?.month_cents),
  };
}

/**
 * Save the delegation. This is the founder writing down, in advance, exactly
 * how far the office may go on its own. Every change is audited, so the
 * authority that allowed a given action can always be read back.
 */
export async function saveDelegation(input: {
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
}): Promise<{ ok: true; delegation: DelegationPolicy } | { ok: false; error: string }> {
  const label = (input.label ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (label.length < 3)
    return { ok: false, error: "Give the delegation a name you will recognise." };
  const actions = (input.allowedActions ?? []).filter((action): action is DelegationAction =>
    (DELEGATABLE_ACTIONS as readonly string[]).includes(action),
  );
  if (actions.length !== (input.allowedActions ?? []).length) {
    return { ok: false, error: "One of those actions cannot be delegated." };
  }
  const rates = (input.allowedRateIds ?? []).filter((id) => delegatableRateIds().includes(id));
  const maxAmount = Math.max(0, Math.round(Number(input.maxAmountCents) || 0));
  if (maxAmount <= 0) return { ok: false, error: "Set a limit for a single action." };
  const perDay = Math.max(0, Math.round(Number(input.maxActionsPerDay) || 0));
  const perMonth = Math.max(0, Math.round(Number(input.maxActionsPerMonth) || 0));
  if (perDay <= 0 || perMonth <= 0) {
    return { ok: false, error: "Set how many actions the delegation may take per day and month." };
  }
  if (perMonth < perDay) {
    return { ok: false, error: "The monthly limit cannot be smaller than the daily limit." };
  }
  if (actions.includes("send_customer_mail") && !input.allowCustomerMail) {
    return { ok: false, error: "Allow customer email, or remove it from the delegated actions." };
  }

  const sql = await getSql();
  const status = input.status === "paused" ? "paused" : "active";
  await sql`
    insert into delegations (
      id, label, status, max_amount_cents, max_actions_per_day, max_actions_per_month,
      allowed_actions_json, allowed_rate_ids_json, allow_customer_mail,
      allow_auto_reconcile, require_accepted_quote, created_at, updated_at, revoked_at
    ) values (
      ${DELEGATION_ID}, ${label}, ${status}, ${maxAmount}, ${perDay}, ${perMonth},
      ${JSON.stringify(actions)}, ${JSON.stringify(rates)}, ${input.allowCustomerMail === true},
      ${input.allowAutoReconcile === true}, ${input.requireAcceptedQuote !== false},
      now(), now(), null
    )
    on conflict (id) do update set
      label = excluded.label,
      status = excluded.status,
      max_amount_cents = excluded.max_amount_cents,
      max_actions_per_day = excluded.max_actions_per_day,
      max_actions_per_month = excluded.max_actions_per_month,
      allowed_actions_json = excluded.allowed_actions_json,
      allowed_rate_ids_json = excluded.allowed_rate_ids_json,
      allow_customer_mail = excluded.allow_customer_mail,
      allow_auto_reconcile = excluded.allow_auto_reconcile,
      require_accepted_quote = excluded.require_accepted_quote,
      updated_at = now(),
      revoked_at = null
  `;
  const delegation = await readDelegationTx(sql);
  await appendAudit(
    "delegation_saved",
    `Delegation "${label}" ${status === "paused" ? "paused" : "active"}`,
    `Actions: ${actions.length ? actions.join(", ") : "none"}. Limit R${(maxAmount / 100).toFixed(2)} per action, ${perDay} per day, ${perMonth} per month. Customer email ${input.allowCustomerMail ? "on" : "off"}. Automatic payment matching ${input.allowAutoReconcile ? "on" : "off"}.`,
    "founder",
  );
  return { ok: true, delegation: delegation as DelegationPolicy };
}

/**
 * Revoke the delegation. It takes effect on the very next action the office
 * would take; there is no grace period and no queue of work already approved.
 */
export async function revokeDelegation(
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`select id from delegations where id = ${DELEGATION_ID}`;
  if (!rows.length) return { ok: false, error: "There is no delegation to revoke." };
  await sql`
    update delegations
    set status = 'revoked', revoked_at = now(), updated_at = now()
    where id = ${DELEGATION_ID}
  `;
  await appendAudit(
    "delegation_revoked",
    "Delegation revoked",
    `The founder revoked the standing delegation. ${reason.replace(/\s+/g, " ").trim().slice(0, 400)}`,
    "founder",
  );
  return { ok: true };
}

async function recordDecisionTx(
  sql: Sql,
  input: {
    agentId: string;
    action: ProposedAction;
    status: DecisionRow["status"];
    trace: ProvisionCheck[];
    reversibility: DecisionRow["reversibility"];
    observation: Record<string, Json>;
    delegationId?: string | null;
  },
): Promise<string> {
  const previous = await readAuditHead(sql);
  const id = randomUUID();
  const evidenceHash = sha256Hex(stableStringify(input.action));
  // The chain covers everything that defines the decision, including the
  // observation, so a tampered row cannot be re-hashed into something valid.
  const recordHash = chainHash(previous, {
    id,
    agentId: input.agentId,
    action: input.action,
    status: input.status,
    trace: input.trace,
    observation: input.observation,
    evidenceHash,
    delegationId: input.delegationId ?? null,
  });
  await sql`
    insert into decisions (
      id, agent_id, action_kind, title, rationale, status, confidence, reversibility,
      amount_cents, constitutional_trace_json, observation_json, action_json,
      evidence_hash, previous_hash, record_hash, delegation_id
    ) values (
      ${id}, ${input.agentId}, ${input.action.kind}, ${input.action.title},
      ${input.action.rationale}, ${input.status}, ${input.action.confidence},
      ${input.reversibility}, ${input.action.amountCents}, ${JSON.stringify(input.trace)},
      ${JSON.stringify(input.observation)}, ${JSON.stringify(input.action)},
      ${evidenceHash}, ${previous}, ${recordHash}, ${input.delegationId ?? null}
    )
  `;
  await sql`
    update company_state set last_audit_hash = ${recordHash}, updated_at = now()
    where id = ${COMPANY.id}
  `;
  await sql`
    update agents
    set decisions_count = decisions_count + 1,
        escalations_count = escalations_count + ${input.status === "escalated" ? 1 : 0},
        last_heartbeat = now(),
        current_task = ${input.action.title},
        status = ${input.status === "blocked" ? "blocked" : "idle"}
    where id = ${input.agentId}
  `;
  return id;
}

/**
 * Apply one action's side effects. Always called with the transaction/handle the
 * caller wants the write to land in, so a ledger entry and its balance movement
 * can never be observed apart.
 */
async function executeAuthorized(
  sql: Sql,
  agentId: string,
  action: ProposedAction,
  approvalId?: string,
): Promise<{ documentId?: string }> {
  const companyName = (action.companyName || String(action.payload.companyName ?? "")).trim();
  const amount = Math.max(0, Math.round(action.amountCents || 0));

  switch (action.kind) {
    case "route_inbound": {
      if (action.relatedId) {
        await sql`
          update inbound_items
          set status = 'routed', routed_to = ${String(action.payload.routedTo ?? agentId)}
          where id = ${action.relatedId}
        `;
      }
      break;
    }
    case "draft_reply": {
      const id = randomUUID();
      const body = typeof action.payload.body === "string" ? action.payload.body : action.rationale;
      await sql`
        insert into documents (id, title, kind, status, summary, related_id)
        values (${id}, ${action.title}, 'correspondence', 'draft', ${body}, ${action.relatedId ?? null})
      `;
      break;
    }
    case "create_lead": {
      const id = randomUUID();
      // The lead must carry the customer's OWN words, not the agent's summary of
      // them. Downstream duties (qualifying, scoring, the sales handoff) decide
      // on this text, and an agent-authored paraphrase would make them score an
      // agent's optimism rather than what the buyer actually wrote.
      const evidence =
        typeof action.payload.evidence === "string" && action.payload.evidence.trim()
          ? action.payload.evidence.trim().slice(0, 4000)
          : action.rationale;
      await sql`
        insert into leads (id, company_name, source, stage, score, summary, inbound_id)
        values (
          ${id},
          ${companyName || "Unnamed company"},
          ${String(action.payload.source ?? "inbound")},
          ${String(action.payload.stage ?? "engaged")},
          ${num(action.payload.score, 40)},
          ${evidence},
          ${action.relatedId ?? null}
        )
      `;
      await sql`
        update inbound_items
        set status = 'routed', routed_to = ${agentId}
        where id = ${action.relatedId ?? ""}
      `;
      break;
    }
    case "update_lead": {
      if (action.relatedId) {
        // Callers that only moved the stage (`keepSummary`) must not overwrite
        // the lead's own words: the summary is the buyer's text, and downstream
        // duties score what the buyer actually wrote, not the agent's note.
        if (action.payload.keepSummary === true) {
          await sql`
            update leads
            set stage = ${String(action.payload.stage ?? "engaged")},
                score = ${num(action.payload.score, 50)},
                updated_at = now()
            where id = ${action.relatedId}
          `;
        } else {
          await sql`
            update leads
            set stage = ${String(action.payload.stage ?? "engaged")},
                score = ${num(action.payload.score, 50)},
                summary = ${action.rationale},
                updated_at = now()
            where id = ${action.relatedId}
          `;
        }
      }
      break;
    }
    case "draft_campaign":
    case "activate_campaign": {
      const budget = amount;
      const books = await loadCompanyTx(sql);
      const canPay =
        action.kind === "activate_campaign" && budget > 0 && books.treasuryCents >= budget;
      const status =
        action.kind === "activate_campaign"
          ? budget === 0
            ? "active"
            : canPay
              ? "active"
              : "awaiting_budget"
          : budget > 0
            ? "awaiting_budget"
            : "draft";
      const spend = canPay ? budget : 0;
      if (action.relatedId) {
        await sql`
          update campaigns
          set name = ${action.title},
              channel = ${String(action.payload.channel ?? "owned")},
              status = ${status},
              budget_cents = ${budget},
              spend_cents = ${spend},
              summary = ${action.rationale}
          where id = ${action.relatedId}
        `;
      } else {
        const id = randomUUID();
        await sql`
          insert into campaigns (id, name, channel, status, budget_cents, spend_cents, summary)
          values (
            ${id}, ${action.title}, ${String(action.payload.channel ?? "owned")},
            ${status}, ${budget}, ${spend}, ${action.rationale}
          )
        `;
      }
      if (canPay) {
        const vat = expenseVat(action.payload.vatTreatment, budget);
        const entryId = randomUUID();
        await sql`
          insert into ledger_entries (id, kind, counterparty, amount_cents, vat_cents, status, memo, related_id)
          values (
            ${entryId}, 'expense', ${String(action.payload.vendor ?? "Media")}, ${budget}, ${vat},
            'paid', ${action.rationale}, ${action.relatedId ?? null}
          )
        `;
        await sql`
          update company_state
          set treasury_cents = treasury_cents - ${budget}, updated_at = now()
          where id = ${COMPANY.id}
        `;
      }
      break;
    }
    case "handoff_to_sales": {
      if (action.relatedId) {
        await sql`
          update leads set stage = 'ready_for_sales', updated_at = now() where id = ${action.relatedId}
        `;
      }
      break;
    }
    case "open_opportunity": {
      // Never point an opportunity at a lead id that does not exist: create the
      // lead if the handoff did not already have one.
      let leadId = action.relatedId ? String(action.relatedId) : null;
      if (leadId) {
        const found = await sql<{ id: string }>`select id from leads where id = ${leadId} limit 1`;
        if (!found.length) leadId = null;
      }
      if (!leadId) {
        leadId = randomUUID();
        await sql`
          insert into leads (id, company_name, source, stage, score, summary)
          values (
            ${leadId}, ${companyName || "Unnamed company"}, 'sales',
            'in_sales', ${num(action.payload.score, 50)}, ${action.rationale}
          )
        `;
      }
      const id = randomUUID();
      // The summary is the buyer's own words when the planner carries them.
      // Quote selection reads this field, so replacing it with the agent's
      // rationale would make the playbook choose from an agent-authored note.
      const summary =
        typeof action.payload.summary === "string" && action.payload.summary.trim()
          ? action.payload.summary.trim().slice(0, 4000)
          : action.rationale;
      await sql`
        insert into opportunities (id, lead_id, company_name, stage, value_cents, summary, handoff_approval_id)
        values (
          ${id}, ${leadId}, ${companyName || "Unnamed company"}, 'discovery',
          ${amount}, ${summary}, ${approvalId ?? null}
        )
      `;
      if (leadId) {
        await sql`
          update leads
          set stage = 'in_sales', updated_at = now()
          where id = ${leadId} and stage <> 'lost'
        `;
      }
      break;
    }
    case "issue_quote": {
      if (action.relatedId) {
        // Do not overwrite the opportunity summary: it carries the buyer's
        // words, and both the quote playbook and later duties read it. Only the
        // stage and the accepted figure change here.
        await sql`
          update opportunities
          set stage = 'proposal',
              value_cents = ${amount},
              updated_at = now()
          where id = ${action.relatedId}
        `;
      }
      const quoteId = randomUUID();
      const body = quoteDocumentBody(quoteId, action);
      const rateId =
        typeof action.payload.rateId === "string" ? action.payload.rateId.trim() : null;
      // Snapshot the figure the customer was actually quoted. An invoice later
      // reads this, not a mutable opportunity value that a later stage change
      // could overwrite.
      await sql`
        insert into documents (id, title, kind, status, summary, related_id, rate_id, amount_cents)
        values (${quoteId}, ${action.title}, 'quote', 'approved_unsent', ${body}, ${action.relatedId ?? null}, ${rateId}, ${amount})
      `;
      break;
    }
    case "advance_opportunity": {
      if (action.relatedId) {
        // A discovery pack is not a re-pricing. When the planner says to keep
        // the record, the opportunity's value and the buyer's summary stay put;
        // otherwise the old behaviour (stage, value and rationale) applies.
        if (action.payload.keepSummary === true) {
          await sql`
            update opportunities
            set stage = ${String(action.payload.stage ?? "proposal")},
                updated_at = now()
            where id = ${action.relatedId}
          `;
        } else {
          await sql`
            update opportunities
            set stage = ${String(action.payload.stage ?? "proposal")},
                value_cents = ${amount || 0},
                summary = ${action.rationale},
                updated_at = now()
            where id = ${action.relatedId}
          `;
        }
      }
      break;
    }
    case "propose_close_won": {
      if (action.relatedId) {
        await sql`
          update opportunities
          set stage = 'won', value_cents = ${amount}, summary = ${action.rationale}, updated_at = now()
          where id = ${action.relatedId}
        `;
      }
      break;
    }
    case "propose_close_lost": {
      if (action.relatedId) {
        await sql`
          update opportunities
          set stage = 'lost', summary = ${action.rationale}, updated_at = now()
          where id = ${action.relatedId}
        `;
      }
      break;
    }
    case "issue_invoice": {
      const cycleId =
        typeof action.payload.cycleId === "string" ? action.payload.cycleId.trim() : "";
      // A billing period may only be invoiced once. The claim is a conditional
      // update, so two ticks racing on the same period cannot both win.
      if (cycleId) {
        const claimed = await sql<{ id: string }>`
          update billing_cycles set status = 'invoiced'
          where id = ${cycleId} and status = 'pending'
          returning id
        `;
        if (!claimed.length) {
          throw new Error("That billing period has already been invoiced.");
        }
      }
      // A one-off subject may only carry one invoice. The database has a partial
      // unique index for this, but checking here records a useful refusal instead
      // of a raw constraint error if two requests race.
      if (!cycleId && action.relatedId) {
        const already = await sql<{ id: string }>`
          select id from ledger_entries
          where kind = 'invoice' and related_id = ${action.relatedId}
          limit 1
        `;
        if (already.length) throw new Error("This work already has an invoice.");
      }
      const id = randomUUID();
      const given = action.payload.vatCents;
      const vat =
        typeof given === "number" && Number.isInteger(given) && given >= 0 && given < amount
          ? given
          : ledgerVat(action.payload.vatTreatment, amount).vatCents;
      await sql`
        insert into ledger_entries (id, kind, counterparty, amount_cents, vat_cents, status, memo, related_id)
        values (${id}, 'invoice', ${companyName || "Counterparty"}, ${amount}, ${vat}, 'issued', ${action.rationale}, ${action.relatedId ?? null})
      `;
      await sql`
        update company_state
        set receivable_cents = receivable_cents + ${amount}, updated_at = now()
        where id = ${COMPANY.id}
      `;
      if (cycleId) {
        const documentId = randomUUID();
        const reference = documentRef(documentId);
        const summary = invoiceCopy(companyName || "Counterparty", amount, reference, {
          treatment: parseVatTreatment(action.payload.vatTreatment),
          netCents: amount - vat,
          vatCents: vat,
        });
        await sql`
          insert into documents (id, title, kind, status, summary, related_id)
          values (${documentId}, ${`Invoice · ${companyName || "Counterparty"}`}, 'invoice', 'approved_unsent', ${summary}, ${cycleId})
        `;
        await sql`
          update billing_cycles
          set invoice_id = ${id}, document_id = ${documentId}
          where id = ${cycleId}
        `;
        return { documentId };
      }
      // One-off work gets the same invoice document a cycle does. The
      // document is deliberately written inside the governed action, not by a
      // caller afterwards, so an invoice can never exist without its paper.
      const documentId = randomUUID();
      const summary = invoiceCopy(companyName || "Counterparty", amount, documentRef(documentId), {
        treatment: parseVatTreatment(action.payload.vatTreatment),
        netCents: amount - vat,
        vatCents: vat,
      });
      await sql`
        insert into documents (id, title, kind, status, summary, related_id)
        values (
          ${documentId}, ${`Invoice · ${companyName || "Counterparty"}`},
          'invoice', 'approved_unsent', ${summary}, ${action.relatedId ?? null}
        )
      `;
      return { documentId };
    }
    case "record_expense": {
      const id = randomUUID();
      const vat = expenseVat(action.payload.vatTreatment, amount);
      const books = await loadCompanyTx(sql);
      const paid = amount > 0 && books.treasuryCents >= amount;
      await sql`
        insert into ledger_entries (id, kind, counterparty, amount_cents, vat_cents, status, memo, related_id)
        values (
          ${id}, 'expense', ${companyName || "Supplier"}, ${amount}, ${vat},
          ${paid ? "paid" : "payable"}, ${action.rationale}, ${action.relatedId ?? null}
        )
      `;
      if (paid) {
        await sql`
          update company_state
          set treasury_cents = treasury_cents - ${amount}, updated_at = now()
          where id = ${COMPANY.id}
        `;
      } else {
        await sql`
          update company_state
          set payable_cents = payable_cents + ${amount}, updated_at = now()
          where id = ${COMPANY.id}
        `;
      }
      break;
    }
    case "record_inbound_payment": {
      const id = randomUUID();
      // A receipt belongs to at most one invoice. The outside check is not
      // enough when two callers race; this one runs under the audit-chain lock
      // and inside the same transaction as the money movement.
      if (action.relatedId) {
        const already = await sql<{ id: string }>`
          select id from ledger_entries
          where kind = 'receipt' and related_id = ${action.relatedId}
          limit 1
        `;
        if (already.length) throw new Error("A receipt is already recorded for this invoice.");
      }
      // Cash may only ever be credited against money that is actually owed. The
      // old code did `treasury += amount` unconditionally and then floored the
      // receivable at zero, so a duplicated receipt — or a payment recorded
      // against nothing — created money from nothing.
      const applied = await applyReceiptAgainstReceivable(sql, amount);
      if (applied <= 0) {
        throw new Error(
          "No outstanding invoice to apply this receipt against. Record the invoice first, or file the payment as a notice for the founder to confirm.",
        );
      }
      await sql`
        insert into ledger_entries (id, kind, counterparty, amount_cents, vat_cents, status, memo, related_id)
        values (${id}, 'receipt', ${companyName || "Counterparty"}, ${applied}, 0, 'cleared', ${action.rationale}, ${action.relatedId ?? null})
      `;
      if (action.relatedId) {
        const invoice = await sql<{ vat_cents: number }>`
          select vat_cents from ledger_entries
          where id = ${action.relatedId} and kind = 'invoice'
          for update
        `.then((rows) => rows[0]);
        if (!invoice) throw new Error("That invoice is not on file.");
        await sql`
          update ledger_entries set status = 'paid'
          where id = ${action.relatedId} and kind = 'invoice'
        `;
        await sql`
          update billing_cycles
          set status = 'paid', paid_at = now()
          where invoice_id = ${action.relatedId} and status <> 'paid'
        `;
        // The customer-facing receipt is written in this transaction too, so a
        // payment can never exist without the paper that acknowledges it.
        const receiptId = randomUUID();
        const invoiceVat = num(invoice.vat_cents);
        await sql`
          insert into documents (id, title, kind, status, summary, related_id)
          select ${receiptId}, ${`Receipt · ${companyName || "Counterparty"}`}, 'receipt',
                 'recorded', ${receiptCopy(companyName || "Counterparty", applied, {
                   treatment: invoiceVat > 0 ? "included" : "none",
                   netCents: applied - invoiceVat,
                   vatCents: invoiceVat,
                 })}, ${action.relatedId}
          where not exists (
            select 1 from documents where kind = 'receipt' and related_id = ${action.relatedId}
          )
        `;
      }
      break;
    }
    case "open_ticket": {
      const id = randomUUID();
      await sql`
        insert into tickets (id, title, severity, status, owner_agent, summary, related_id)
        values (
          ${id}, ${action.title}, ${String(action.payload.severity ?? "p3")}, 'open',
          ${String(action.payload.owner ?? "forge")}, ${action.rationale}, ${action.relatedId ?? null}
        )
      `;
      break;
    }
    case "update_ticket": {
      if (action.relatedId) {
        await sql`
          update tickets
          set status = ${String(action.payload.status ?? "in_progress")},
              summary = ${action.rationale},
              updated_at = now()
          where id = ${action.relatedId}
        `;
      }
      break;
    }
    case "draft_document": {
      const id = randomUUID();
      await sql`
        insert into documents (id, title, kind, status, summary, related_id)
        values (${id}, ${action.title}, ${String(action.payload.kind ?? "internal")}, 'draft', ${action.rationale}, ${action.relatedId ?? null})
      `;
      break;
    }
    case "escalate_account_risk": {
      const id = randomUUID();
      await sql`
        insert into documents (id, title, kind, status, summary, related_id)
        values (
          ${id},
          ${"Service risk raised for founder decision"},
          'correspondence',
          'held',
          ${`${action.rationale} Nothing was refunded, credited, cancelled or promised. The founder decides the customer outcome.`},
          ${action.relatedId ?? null}
        )
      `;
      break;
    }
    case "notify_operator":
      break;
    case "fulfil_service": {
      // The deliverable was produced by the office from its own records and is
      // carried in the payload. It is written down as a document so the
      // customer can be sent exactly what was produced.
      const cycleId = String(action.payload.cycleId ?? action.relatedId ?? "");
      const report = String(action.payload.reportBody ?? "").trim();
      if (!report) throw new Error("A service cannot be fulfilled without a deliverable.");
      const id = randomUUID();
      await sql`
        insert into documents (id, title, kind, status, summary, related_id)
        values (${id}, ${action.title}, 'service_report', 'delivered', ${report}, ${cycleId || null})
      `;
      if (cycleId) {
        // Cash can arrive before the report is produced. Keep the paid status in
        // that case: fulfilment is still owed, but the period is settled.
        await sql`
          update billing_cycles
          set status = case when status = 'paid' then 'paid' else 'fulfilled' end,
              report_document_id = ${id}, fulfilled_at = now()
          where id = ${cycleId} and status in ('pending', 'invoiced', 'paid')
        `;
      }
      return { documentId: id };
    }
    case "start_subscription": {
      const planId = String(action.payload.planId ?? "");
      const rateId = String(action.payload.rateId ?? "");
      const priceCents = Math.max(0, Math.round(Number(action.payload.priceCents ?? 0)));
      if (!planId || !rateId || priceCents <= 0) {
        throw new Error("A subscription needs a plan, a rate line, and a price.");
      }
      const opportunityId = String(action.payload.opportunityId ?? action.relatedId ?? "");
      if (opportunityId) {
        const already = await sql<{ id: string }>`
          select id from subscriptions
          where opportunity_id = ${opportunityId} and status <> 'cancelled'
          limit 1
        `;
        if (already.length) throw new Error("That job already has a subscription.");
      }
      const id = randomUUID();
      const cycle = String(action.payload.cycle ?? "monthly");
      const periodStart = String(action.payload.periodStart ?? new Date().toISOString());
      await sql`
        insert into subscriptions (
          id, company_name, contact_name, contact_email, plan_id, rate_id, cycle,
          price_cents, status, opportunity_id, quote_document_id, started_at,
          next_billing_at, created_at, updated_at
        ) values (
          ${id}, ${companyName}, ${String(action.payload.contactName ?? "") || null},
          ${String(action.payload.contactEmail ?? "") || null}, ${planId}, ${rateId}, ${cycle},
          ${priceCents}, 'active', ${String(action.payload.opportunityId ?? "") || null},
          ${String(action.payload.quoteDocumentId ?? "") || null}, ${periodStart},
          ${periodStart}, now(), now()
        )
      `;
      return { documentId: id };
    }
    case "cancel_subscription": {
      const id = String(action.relatedId ?? "");
      if (!id) throw new Error("A subscription needs an id to cancel.");
      const reason = String(action.payload.reason ?? action.rationale).slice(0, 400);
      const updated = await sql<{ id: string }>`
        update subscriptions
        set status = 'cancelled', cancelled_at = now(), cancellation_reason = ${reason},
            updated_at = now()
        where id = ${id} and status <> 'cancelled'
        returning id
      `;
      if (!updated.length) throw new Error("That subscription is already cancelled.");
      await sql`
        update billing_cycles
        set status = 'cancelled'
        where subscription_id = ${id} and status in ('pending', 'invoiced') and period_start > now()
      `;
      break;
    }
    case "send_customer_mail": {
      const template = String(action.payload.template ?? "");
      const { draftNotice } = await import("./customer-notice.server");
      const isQuote = template === "quote";
      let quoteToken: string | null = null;
      if (isQuote) {
        const quoteDocumentId = String(action.payload.quoteDocumentId ?? "");
        if (!quoteDocumentId) throw new Error("A quote notice needs a quote to send.");
        const link = await createQuoteLinkTx(sql, quoteDocumentId, {
          actor: agentId,
          revokeExisting: false,
        });
        if (!link.ok) throw new Error(link.error);
        quoteToken = link.token;
      }
      const draft = await draftNotice(sql, {
        template: template as never,
        companyName,
        cycleId: String(action.payload.cycleId ?? "") || null,
        quoteDocumentId: String(action.payload.quoteDocumentId ?? "") || null,
        subscriptionId: String(action.payload.subscriptionId ?? "") || null,
        invoiceId: String(action.payload.invoiceId ?? "") || null,
        receiptId: String(action.payload.receiptId ?? "") || null,
        quoteToken,
      });
      if (!draft.ok) throw new Error(draft.error);
      const id = randomUUID();
      await sql`
        insert into customer_notices (
          id, document_id, subscription_id, cycle_id, company_name, template,
          recipient, subject, body, status, created_at, related_id
        ) values (
          ${id}, ${String(action.payload.quoteDocumentId ?? "") || null},
          ${String(action.payload.subscriptionId ?? "") || null},
          ${String(action.payload.cycleId ?? "") || null},
          ${companyName || null}, ${template}, ${draft.recipient}, ${draft.subject},
          ${draft.body}, 'approved_unsent', now(), ${action.relatedId ?? null}
        )
      `;
      return { documentId: id };
    }
    default:
      throw new Error(`Unknown action kind: ${action.kind}`);
  }
  return {};
}

// ── Governed decisions ───────────────────────────────────────────────────────
//
// Four things live here, and they are four different records of one moment:
//
//   1. the RISK TIER of an action (risk.ts) — one word that says how much of
//      the founder's judgement an action is asking for;
//   2. the POPIA section 71 GATE (gate71.ts) — the five-question test, and the
//      reasoning the founder must write down before a legal action is exposed;
//   3. the DECISION EPISODE (precedent.ts) — what the founder decided, under
//      which material conditions, so the same question can be put to them
//      with the last answer in front of them;
//   4. the EXECUTION RECEIPT — a signed statement of what ran, under which
//      authority, and against which audit chain head.
//
// All four are pure modules doing the thinking; this file is where their
// answers are written down.

/**
 * Action kinds whose outcome is a customer loss.
 *
 * These are the decisions that end a relationship with a person, so they are
 * the ones where POPIA section 71 bites hardest: the processing is profiling
 * a customer because the office is ranking, scoring and closing them.
 */
const CUSTOMER_LOSS_KINDS = new Set([
  "propose_close_lost",
  "escalate_account_risk",
  "cancel_subscription",
]);

/** The tier an action sits in, and why. */
function riskOfAction(action: ProposedAction): RiskAssessment {
  return assessRisk({
    kind: action.kind,
    amountCents: action.amountCents,
    companyName: action.companyName,
    payload: action.payload,
  });
}

/**
 * Run the section 71 test with the answers the office can determine on its
 * own.
 *
 * `humanJudgedFirst` is false on purpose. Nobody has judged the case yet —
 * the founder is being asked to — and saying so is what promotes the action
 * to a legal gate: the gate exists precisely because the machine proposed
 * something before a human had looked at the case.
 */
function gateOutcomeFor(action: ProposedAction, risk: RiskAssessment): GateOutcome {
  const legal = risk.name === "1-Legal";
  return runGate71({
    significantEffect: legal,
    humanJudgedFirst: false,
    profiling: legal && CUSTOMER_LOSS_KINDS.has(action.kind),
    purposeConsistent: true,
    explainable: true,
  });
}

/** The policy version the office is running under right now. */
function policyVersionOf(company: CompanySnapshot): string {
  return company.constitutionVersion;
}

/**
 * The stage of the opportunity this decision is about, if one is linked.
 *
 * Two ways to find it: the action may point at the opportunity directly, and
 * failing that the company may have one on file. Stage is a material
 * condition of a ruling, so it is worth the extra read.
 */
async function stageForDecision(
  sql: Sql,
  action: ProposedAction,
  companyName: string | null,
): Promise<string | null> {
  const relatedId = action.relatedId ?? "";
  if (relatedId) {
    const direct = await sql<{ stage: string }>`
      select stage from opportunities where id = ${relatedId} limit 1
    `;
    if (direct[0]?.stage) return String(direct[0].stage);
  }
  if (companyName && companyName.trim() !== "") {
    const byCompany = await sql<{ stage: string }>`
      select stage from opportunities
      where lower(company_name) = ${companyName.trim().toLowerCase()}
      order by created_at desc
      limit 1
    `;
    if (byCompany[0]?.stage) return String(byCompany[0].stage);
  }
  return null;
}

/**
 * The key a decision receipt is signed with.
 *
 * The receipt's whole purpose is to be checkable by somebody else, later, so
 * it must be signed with a key that is not in the repository. In a deployed
 * office that is BETTER_AUTH_SECRET, falling back to CRON_SECRET for an
 * installation that only ever runs the scheduler.
 *
 * A receipt signed with the LOCAL key below is NOT a production receipt. The
 * local key is in the source code, so anyone can forge a receipt that
 * verifies against it. It exists so a local or preview office still records
 * that a decision was taken and signed; treat it as a placeholder, not as
 * evidence.
 */
function receiptSigningKey(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim() || process.env.CRON_SECRET?.trim() || "";
  if (secret) return sha256Hex(`vantage-ars:decision-receipt:${secret}`);
  return sha256Hex("vantage-ars:decision-receipt:LOCAL-KEY-NOT-A-PRODUCTION-RECEIPT");
}

/**
 * Write a signed receipt for an execution that carries real consequence.
 *
 * Only Tier 1–3 actions get one: a receipt for a routine note would be
 * noise, and a receipt for a Tier 4 judgement call would say nothing. The
 * signature is an HMAC over the receipt's own payload, so a receipt that has
 * been edited no longer verifies.
 */
async function writeDecisionReceiptTx(
  sql: Sql,
  input: {
    decisionId: string;
    action: ProposedAction;
    risk: RiskAssessment;
    agentId: string;
    approvalId?: string | null;
    delegationId?: string | null;
    approvedBy?: string | null;
  },
): Promise<void> {
  const chainHead = await readAuditHead(sql);
  const payload = {
    actionKind: input.action.kind,
    amountCents: Math.max(0, Math.round(input.action.amountCents || 0)),
    companyName: (
      input.action.companyName || String(input.action.payload.companyName ?? "")
    ).trim(),
    agentId: input.agentId,
    approvalId: input.approvalId ?? null,
    delegationId: input.delegationId ?? null,
    chainHead,
  };
  const payloadJson = stableStringify(payload);
  const signature = createHmac("sha256", receiptSigningKey()).update(payloadJson).digest("hex");
  await sql`
    insert into decision_receipts (
      id, decision_id, action_kind, amount_cents, risk_tier, delegation_id,
      approved_by, approval_id, chain_head, payload_json, signature
    ) values (
      ${randomUUID()}, ${input.decisionId}, ${input.action.kind}, ${payload.amountCents},
      ${input.risk.name}, ${input.delegationId ?? null}, ${input.approvedBy ?? null},
      ${input.approvalId ?? null}, ${chainHead}, ${payloadJson}, ${signature}
    )
  `;
}

/**
 * Write the §71 record for a case: the five questions, as answered.
 *
 * Called once when the gate is opened (before anyone has decided) and again
 * when the founder's decision is recorded, so the record shows both the test
 * and the answer to it.
 */
async function writeGateRecordTx(
  sql: Sql,
  input: {
    approvalId: string;
    decisionId?: string | null;
    gate: GateOutcome;
    policyVersion: string;
    reasoning?: string | null;
    evidenceShown?: string | null;
    decided?: boolean;
  },
): Promise<void> {
  await sql`
    insert into gate_records (
      id, approval_id, decision_id, questions_json, legal, failed_question,
      pre_exposure_reasoning, evidence_shown, policy_version, exposure_at, decided_at
    ) values (
      ${randomUUID()}, ${input.approvalId}, ${input.decisionId ?? null},
      ${JSON.stringify(input.gate.questions)}, ${input.gate.legal},
      ${input.gate.failed}, ${input.reasoning ?? null}, ${input.evidenceShown ?? null},
      ${input.policyVersion}, now(),
      case when ${input.decided === true} then now() else null end
    )
  `;
}

/**
 * Record what the founder decided, and under which conditions.
 *
 * One row per Tier 1–3 human ruling. The material conditions — action kind,
 * company, amount band, stage, policy version — are what a later decision is
 * compared against, so they are stored with the ruling rather than inferred
 * from it afterwards.
 *
 * `later_outcome` is left null on purpose: it is filled in by a later pass
 * that knows what actually happened, and nothing else may write it.
 */
async function recordDecisionEpisodeTx(
  sql: Sql,
  input: {
    decisionId: string | null;
    action: ProposedAction;
    companyName: string | null;
    outcome: "approved" | "rejected";
    reasonCode: string;
    reasoning: string;
    exceptionConditions: string | null;
    policyVersion: string;
    stage: string | null;
    agentId: string;
  },
): Promise<void> {
  const amountCents = Math.max(0, Math.round(input.action.amountCents || 0));
  await sql`
    insert into decision_episodes (
      id, action_kind, company_name, amount_cents, amount_band, stage, policy_version,
      outcome, reason_code, reasoning, exception_conditions, later_outcome, decided_at,
      decision_id, agent_id
    ) values (
      ${randomUUID()}, ${input.action.kind}, ${input.companyName}, ${amountCents},
      ${amountBand(amountCents)}, ${input.stage}, ${input.policyVersion},
      ${input.outcome}, ${input.reasonCode}, ${input.reasoning},
      ${input.exceptionConditions}, null, now(),
      ${input.decisionId}, ${input.agentId}
    )
  `;
}

/** The exception conditions an action carried, if it named any. */
function exceptionConditionsOf(action: ProposedAction): string | null {
  const stated = action.payload.exceptionConditions;
  if (typeof stated !== "string") return null;
  const text = stated.trim();
  return text === "" ? null : text.slice(0, 2000);
}

/**
 * A reason code from the fixed taxonomy, or the honest default.
 *
 * The taxonomy is closed on purpose: a governance record whose vocabulary can
 * grow at runtime cannot be counted against itself across years. When the
 * founder gave no code, the ruling still happened at a human gate, and
 * `escalated_to_human` says exactly that without claiming anything more.
 */
function episodeReasonCode(reasonCode: string | null): string {
  const code = (reasonCode ?? "").trim();
  if (code && REASON_CODES.some((entry) => entry.code === code)) return code;
  return "escalated_to_human";
}

/**
 * The founder's reasoning for a ruling.
 *
 * Their own words if they gave any, and otherwise one plain sentence that
 * says what happened. The episode is never written with an empty reason.
 */
function episodeReasoning(
  reasoning: string | null,
  note: string,
  outcome: "approved" | "rejected",
): string {
  const written = (reasoning ?? "").trim();
  if (written) return written;
  if (note) return note;
  return `The founder ${outcome === "approved" ? "approved" : "refused"} this action at the founder gate.`;
}

/** One row of the precedent memory, as the founder's screen reads it. */
export type DecisionEpisodeRow = {
  id: string;
  actionKind: string;
  companyName: string | null;
  amountCents: number;
  amountBand: string | null;
  stage: string | null;
  policyVersion: string | null;
  outcome: "approved" | "rejected";
  reasonCode: string;
  reasoning: string;
  exceptionConditions: string | null;
  laterOutcome: string | null;
  decidedAt: string;
  decisionId: string | null;
  agentId: string | null;
};

function mapDecisionEpisode(row: Record<string, unknown>): DecisionEpisodeRow {
  return {
    id: String(row.id),
    actionKind: String(row.action_kind),
    companyName: row.company_name ? String(row.company_name) : null,
    amountCents: num(row.amount_cents),
    amountBand: row.amount_band ? String(row.amount_band) : null,
    stage: row.stage ? String(row.stage) : null,
    policyVersion: row.policy_version ? String(row.policy_version) : null,
    outcome: (String(row.outcome) === "rejected" ? "rejected" : "approved") as
      "approved" | "rejected",
    reasonCode: String(row.reason_code ?? ""),
    reasoning: String(row.reasoning ?? ""),
    exceptionConditions: row.exception_conditions ? String(row.exception_conditions) : null,
    laterOutcome: row.later_outcome ? String(row.later_outcome) : null,
    decidedAt: iso(row.decided_at),
    decisionId: row.decision_id ? String(row.decision_id) : null,
    agentId: row.agent_id ? String(row.agent_id) : null,
  };
}

/** The precedent memory, as the comparison module wants it. */
function asEpisode(row: DecisionEpisodeRow): DecisionEpisode {
  return {
    id: row.id,
    actionKind: row.actionKind,
    conditions: {
      companyName: row.companyName,
      amountBand: row.amountBand,
      stage: row.stage,
      jurisdiction: null,
      policyVersion: row.policyVersion,
    },
    reasonCode: row.reasonCode,
    reasoning: row.reasoning,
    outcome: row.outcome,
    exceptionConditions: row.exceptionConditions,
    laterOutcome: row.laterOutcome,
    decidedAt: row.decidedAt,
  };
}

/**
 * The founder's precedent history, newest first.
 *
 * The rulings that carry consequence: a decision that was never gated has
 * nothing to teach the next one.
 */
export async function listDecisionEpisodes(limit = 50): Promise<DecisionEpisodeRow[]> {
  await ensureOffice();
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from decision_episodes
    order by decided_at desc, id desc
    limit ${Math.max(1, Math.min(Math.trunc(limit) || 1, 200))}
  `;
  return rows.map(mapDecisionEpisode);
}

/** The §71 gate record, as the founder's record explorer reads it. */
export type GateRecordRow = {
  id: string;
  approvalId: string;
  decisionId: string | null;
  questions: GateAnswer[];
  legal: boolean;
  failedQuestion: string | null;
  reasoning: string | null;
  evidenceShown: string | null;
  policyVersion: string;
  exposureAt: string;
  decidedAt: string | null;
  createdAt: string;
};

/** A signed execution receipt, with the signature checked at read time. */
export type DecisionReceiptRow = {
  id: string;
  decisionId: string;
  actionKind: string;
  amountCents: number;
  riskTier: string;
  delegationId: string | null;
  approvedBy: string | null;
  approvalId: string | null;
  chainHead: string;
  signatureValid: boolean;
  signedAt: string;
};

export type GovernanceRecord = {
  episodes: DecisionEpisodeRow[];
  gates: GateRecordRow[];
  receipts: DecisionReceiptRow[];
  /** Whether receipts are signed with a deployment secret or the local placeholder. */
  receiptKey: "environment" | "placeholder";
};

function questionsOf(value: unknown): GateAnswer[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const question = typeof row.question === "string" ? row.question : "";
    if (!question) return [];
    return [
      {
        question: question as GateAnswer["question"],
        passed: row.passed === true,
        detail: typeof row.detail === "string" ? row.detail : "",
      },
    ];
  });
}

/**
 * The gate's written record, newest first.
 *
 * A row with no `decided_at` is an open gate: the case reached a human and the
 * human has not ruled yet. Skipping an approval leaves that shape visible
 * rather than pretending a decision was made.
 */
export async function listGateRecords(limit = 100): Promise<GateRecordRow[]> {
  await ensureOffice();
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from gate_records
    order by created_at desc, id desc
    limit ${Math.max(1, Math.min(Math.trunc(limit) || 1, 500))}
  `;
  return rows.map((row) => ({
    id: String(row.id),
    approvalId: String(row.approval_id),
    decisionId: row.decision_id ? String(row.decision_id) : null,
    questions: questionsOf(row.questions_json),
    legal: row.legal === true,
    failedQuestion: row.failed_question ? String(row.failed_question) : null,
    reasoning: row.pre_exposure_reasoning ? String(row.pre_exposure_reasoning) : null,
    evidenceShown: row.evidence_shown ? String(row.evidence_shown) : null,
    policyVersion: String(row.policy_version ?? ""),
    exposureAt: iso(row.exposure_at ?? row.created_at),
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    createdAt: iso(row.created_at),
  }));
}

function signatureValid(payloadJson: string, signature: string): boolean {
  const expected = createHmac("sha256", receiptSigningKey()).update(payloadJson).digest();
  const given = /^[0-9a-f]+$/i.test(signature) ? Buffer.from(signature, "hex") : Buffer.alloc(0);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The signed receipts, newest first, each checked against the deployment key.
 *
 * A valid signature proves the receipt was written by this office. When the
 * office is running on the local placeholder key, the screen says so: the
 * signature is structurally valid but not evidence against a third party.
 */
export async function listDecisionReceipts(limit = 100): Promise<DecisionReceiptRow[]> {
  await ensureOffice();
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from decision_receipts
    order by signed_at desc, id desc
    limit ${Math.max(1, Math.min(Math.trunc(limit) || 1, 500))}
  `;
  return rows.map((row) => ({
    id: String(row.id),
    decisionId: String(row.decision_id),
    actionKind: String(row.action_kind),
    amountCents: num(row.amount_cents),
    riskTier: String(row.risk_tier ?? ""),
    delegationId: row.delegation_id ? String(row.delegation_id) : null,
    approvedBy: row.approved_by ? String(row.approved_by) : null,
    approvalId: row.approval_id ? String(row.approval_id) : null,
    chainHead: String(row.chain_head ?? ""),
    signatureValid: signatureValid(String(row.payload_json ?? ""), String(row.signature ?? "")),
    signedAt: iso(row.signed_at),
  }));
}

/** The whole governance record in one read, so the explorer cannot split it. */
export async function readGovernanceRecord(limit = 100): Promise<GovernanceRecord> {
  const [episodes, gates, receipts] = await Promise.all([
    listDecisionEpisodes(limit),
    listGateRecords(limit),
    listDecisionReceipts(limit),
  ]);
  return {
    episodes,
    gates,
    receipts,
    receiptKey:
      process.env.BETTER_AUTH_SECRET?.trim() || process.env.CRON_SECRET?.trim()
        ? "environment"
        : "placeholder",
  };
}

/**
 * Everything the founder needs to decide one approval.
 *
 * One plain object: the approval itself, the risk tier it sits in, the §71
 * gate and its five questions, whether a written reason is required before
 * the action may be exposed, the fixed reason codes, the earlier rulings on
 * the same terms, and what those rulings say about this one.
 *
 * A precedent is evidence, never authority. Nothing here can allow an action;
 * it can only show the founder what they decided last time.
 */
export type ApprovalContext = {
  approval: {
    id: string;
    kind: ApprovalKind;
    title: string;
    rationale: string;
    amountCents: number;
    agentId: string;
    companyName: string | null;
    createdAt: string;
    riskScore: number;
    actionKind: string;
  };
  risk: {
    tier: RiskTier;
    name: RiskTierName;
    rationale: string;
    gated: boolean;
    personalData: boolean;
  };
  gate: {
    legal: boolean;
    questions: GateAnswer[];
    failed: GateQuestion | null;
    summary: string;
  };
  requiresReasoning: boolean;
  reasonCodes: { code: string; label: string }[];
  precedent: {
    episodeId: string;
    actionKind: string;
    outcome: "approved" | "rejected";
    similarity: PrecedentMatch["similarity"];
    difference: string | null;
    effect: PrecedentMatch["effect"];
    decidedAt: string;
    reasoning: string;
    reasonCode: string;
  }[];
  guidance: string;
};

export async function getApprovalContext(approvalId: string): Promise<ApprovalContext> {
  await ensureOffice();
  const sql = await getSql();
  const row = await sql<Record<string, unknown>>`
    select * from approvals where id = ${approvalId} limit 1
  `.then((rows) => rows[0]);
  if (!row) throw new Error("That approval is not on file.");

  const action = parseJson<ProposedAction>(row.action_json, {
    kind: "notify_operator",
    title: String(row.title),
    rationale: String(row.rationale),
    confidence: 1,
    amountCents: num(row.amount_cents),
    payload: {},
  });
  const risk = riskOfAction(action);
  const gate = gateOutcomeFor(action, risk);
  const company = await loadCompany();
  const policyVersion = policyVersionOf(company);
  const companyName = row.company_name ? String(row.company_name) : null;
  const amountCents = num(row.amount_cents);
  const stage = await stageForDecision(sql, action, companyName);

  const earlier = await sql<Record<string, unknown>>`
    select * from decision_episodes
    where action_kind = ${action.kind}
    order by decided_at desc
    limit 50
  `;
  const episodes = earlier.map(mapDecisionEpisode).map(asEpisode);

  const candidate: DecisionEpisode = {
    id: `pending:${String(row.id)}`,
    actionKind: action.kind,
    conditions: {
      companyName,
      amountBand: amountBand(amountCents),
      stage,
      jurisdiction: null,
      policyVersion,
    },
    reasonCode: "",
    reasoning: "",
    outcome: "approved",
    exceptionConditions: null,
    laterOutcome: null,
    decidedAt: iso(row.created_at),
  };

  const matches = retrievePrecedent(episodes, candidate);
  const advice = precedentAdvice(matches);

  return {
    approval: {
      id: String(row.id),
      kind: String(row.kind) as ApprovalKind,
      title: String(row.title),
      rationale: String(row.rationale),
      amountCents,
      agentId: String(row.agent_id),
      companyName,
      createdAt: iso(row.created_at),
      riskScore: num(row.risk_score),
      actionKind: action.kind,
    },
    risk: {
      tier: risk.tier,
      name: risk.name,
      rationale: risk.rationale,
      gated: risk.gated,
      personalData: risk.personalData,
    },
    gate: {
      legal: gate.legal,
      questions: gate.questions,
      failed: gate.failed,
      summary: gate.summary,
    },
    requiresReasoning: requiresPreExposureReasoning(gate),
    reasonCodes: REASON_CODES.map((entry) => ({ code: entry.code, label: entry.label })),
    precedent: matches.map((match) => ({
      episodeId: match.episode.id,
      actionKind: match.episode.actionKind,
      outcome: match.episode.outcome,
      similarity: match.similarity,
      difference: match.difference,
      effect: match.effect,
      decidedAt: match.episode.decidedAt,
      reasoning: match.episode.reasoning,
      reasonCode: match.episode.reasonCode,
    })),
    guidance: advice.guidance,
  };
}

/**
 * Authorise, execute and record one proposed action.
 *
 * Everything that mutates state happens inside a single transaction that holds
 * the audit-chain lock, so the decision row, the audit row, the chain head, and
 * the action's own side effects all land together or not at all. Previously the
 * side effects ran before the decision was recorded, so a throw mid-way left a
 * ledger entry with no decision and no audit trail.
 */
export async function applyProposedAction(
  agentId: string,
  action: ProposedAction,
  observation: { [key: string]: Json },
): Promise<{
  decisionId: string;
  approvalId?: string;
  status: DecisionRow["status"];
  error?: string;
  documentId?: string;
  /** What happened when the notice was put in front of the mail server. */
  delivery?: { ok: boolean; detail?: string };
}> {
  const autonomous = observation.autonomous === true;
  /**
   * A failed execution must roll the whole transaction back. The decision is
   * then recorded in its own transaction, after the rollback, so the office
   * still has an audit trail without committing the half-finished action that
   * caused the failure.
   */
  let failure: { error: string; trace: ProvisionCheck[]; reversibility: Reversibility } | null =
    null;
  let result: {
    decisionId: string;
    approvalId?: string;
    status: DecisionRow["status"];
    error?: string;
    documentId?: string;
  };
  try {
    result = await withChain(async (tx) => {
      const company = await loadCompanyTx(tx);
      const companyName = (action.companyName || String(action.payload.companyName ?? "")).trim();
      // A delegation is the office acting for itself. A founder action is not
      // covered by one, and must never consume the office's autonomous budget.
      const delegation = autonomous ? await readDelegationTx(tx) : null;
      const usage =
        autonomous && delegation ? await readDelegationUsageTx(tx, delegation.id) : null;
      // Resolve the subject first: "won" and "accepted" must describe the job in
      // this action, not merely another job at the same customer.
      const subjectOpportunityId = await opportunityIdForAction(tx, action);
      const extras = {
        approvedHandoff: companyName ? await hasApprovedHandoff(tx, companyName) : false,
        opportunityWon: subjectOpportunityId
          ? await hasWonOpportunityById(tx, subjectOpportunityId)
          : companyName
            ? await hasWonOpportunity(tx, companyName)
            : false,
        acceptedQuote: subjectOpportunityId
          ? await hasAcceptedQuoteById(tx, subjectOpportunityId)
          : companyName
            ? await hasAcceptedQuote(tx, companyName)
            : false,
        realEnquiry: companyName ? await hasRealEnquiry(tx, companyName) : false,
        founderInitiated: !autonomous,
        delegation,
        delegationUsage: usage
          ? { usedToday: usage.usedToday, usedThisMonth: usage.usedThisMonth }
          : undefined,
      };
      const auth = authorizeAction(action, agentId, company, extras);

      if (auth.verdict === "deny") {
        const decisionId = await recordDecisionTx(tx, {
          agentId,
          action,
          status: "blocked",
          trace: auth.trace,
          reversibility: auth.reversibility,
          observation: { ...observation, reason: auth.reason },
        });
        await appendAuditTx(tx, "decision_blocked", action.title, auth.reason, agentId);
        return { decisionId, status: "blocked" as const };
      }

      if (auth.verdict === "review") {
        const approvalId = randomUUID();
        const risk = riskOfAction(action);
        const gate = gateOutcomeFor(action, risk);
        const policyVersion = policyVersionOf(company);
        await tx`
        insert into approvals (
          id, kind, title, rationale, amount_cents, agent_id, company_name, status,
          risk_score, constitutional_trace_json, action_json, policy_version
        ) values (
          ${approvalId}, ${auth.approvalKind ?? "constraint_margin"}, ${action.title},
          ${auth.reason}, ${action.amountCents}, ${agentId}, ${companyName || null},
          'pending', ${Math.round((1 - action.confidence) * 100)},
          ${JSON.stringify(auth.trace)}, ${JSON.stringify(action)}, ${policyVersion}
        )
      `;
        const decisionId = await recordDecisionTx(tx, {
          agentId,
          action,
          status: "escalated",
          trace: auth.trace,
          reversibility: auth.reversibility,
          observation: { ...observation, reason: auth.reason, approvalId },
        });
        // A legal action is opened with its §71 test already written down, so the
        // record exists before the founder is asked rather than after they have
        // answered. The gate is open because nobody has judged the case yet.
        if (gate.legal) {
          await writeGateRecordTx(tx, {
            approvalId,
            decisionId,
            gate,
            policyVersion,
          });
        }
        await appendAuditTx(
          tx,
          "approval_opened",
          action.title,
          `${auth.reason} Gate: ${auth.approvalKind ?? "review"}.`,
          agentId,
        );
        // Mail is best-effort and happens after commit: a slow SMTP call must not
        // hold the audit lock open.
        void notifyApproval({
          gate: auth.approvalKind ?? "review",
          title: action.title,
          reason: auth.reason,
          amountCents: action.amountCents,
          companyName,
        });
        return { decisionId, approvalId, status: "escalated" as const };
      }

      let decisionId: string;
      let documentId: string | undefined;
      try {
        const executed = await executeAuthorized(tx, agentId, action);
        documentId = executed.documentId;
        // The delegation is spent here, in the same transaction that took the
        // action, so the caps are counted from real rows and a retried tick
        // cannot slip past them.
        if (auth.delegation && delegation) {
          const now = new Date();
          await tx`
          insert into delegation_usage (
            id, delegation_id, action_kind, amount_cents, company_name, usage_day, usage_month
          ) values (
            ${randomUUID()}, ${delegation.id}, ${action.kind}, ${action.amountCents},
            ${companyName || null}, ${now.toISOString().slice(0, 10)},
            ${now.toISOString().slice(0, 7)}
          )
        `;
        }
        decisionId = await recordDecisionTx(tx, {
          agentId,
          action,
          status: "executed",
          trace: auth.trace,
          reversibility: auth.reversibility,
          observation,
          delegationId: auth.delegation?.id ?? null,
        });
        await appendAuditTx(tx, "decision_executed", action.title, action.rationale, agentId);
        // An execution that carries consequence is signed for. Tier 1–3 only:
        // a receipt for a routine note would be noise.
        const risk = riskOfAction(action);
        if (risk.tier === 1 || risk.tier === 2 || risk.tier === 3) {
          await writeDecisionReceiptTx(tx, {
            decisionId,
            action,
            risk,
            agentId,
            delegationId: auth.delegation?.id ?? null,
            approvedBy: auth.delegation ? auth.delegation.label : null,
          });
        }
      } catch (error) {
        // Re-throw so the outer transaction rolls back every write the action
        // made before it failed. Recording the blocked decision inside this
        // transaction would commit those partial writes, which is exactly the
        // half-applied ledger state this function claims to prevent.
        failure = {
          error: error instanceof Error ? error.message : "Execution failed.",
          trace: auth.trace,
          reversibility: auth.reversibility,
        };
        throw error;
      }
      return { decisionId, status: "executed" as const, documentId };
    });
  } catch (error) {
    const failed = failure as {
      error: string;
      trace: ProvisionCheck[];
      reversibility: Reversibility;
    } | null;
    if (!failed) throw error;
    // The action's writes are gone. Record the refusal in a fresh transaction so
    // the failure is visible in the audit chain rather than silent.
    result = await withChain(async (tx) => {
      const failedId = await recordDecisionTx(tx, {
        agentId,
        action,
        status: "blocked",
        trace: failed.trace,
        reversibility: failed.reversibility,
        observation: { ...observation, reason: failed.error, executionError: true },
      });
      await appendAuditTx(tx, "decision_blocked", action.title, failed.error, agentId);
      return { decisionId: failedId, status: "blocked" as const, error: failed.error };
    });
  }

  // A customer email is sent after the transaction commits, so a slow SMTP
  // call can never hold the audit-chain lock open. The notice is already on
  // file; this is the delivery step, and it records what happened.
  if (result.status === "executed" && result.documentId && action.kind === "send_customer_mail") {
    const { deliverNotice } = await import("./customer-notice.server");
    const sql = await getSql();
    const delivery = await deliverNotice(sql, result.documentId).catch(() => ({
      ok: false,
      detail: "The delivery attempt failed.",
    }));
    return { ...result, delivery };
  }

  return result;
}

async function notifyApproval(input: {
  gate: string;
  title: string;
  reason: string;
  amountCents: number;
  companyName: string;
}): Promise<void> {
  try {
    const { deliverFounderNotice } = await import("./notify.server");
    const { founderApprovalNotice } = await import("./notice");
    await deliverFounderNotice(founderApprovalNotice(input));
  } catch {
    // The approval is already on the desk and in the audit trail.
  }
}

/**
 * Founder decision on an escalated action.
 *
 * The approval row is CLAIMED with a conditional update (`where status =
 * 'pending' returning id`) before anything executes, inside the same
 * transaction that performs the work. Two clicks, two tabs, or a retry after a
 * network timeout can therefore never execute the action twice — which is the
 * difference between one invoice and two.
 *
 * A legal decision (POPIA section 71) may not be resolved at all until the
 * founder's reasoning has been written down: a reason code from the fixed
 * taxonomy, the reasoning itself, and the evidence that was shown. That check
 * happens BEFORE the row is claimed and before anything executes, so a legal
 * action can never reach the outside world on the machine's say-so alone.
 */
export async function resolveApproval(input: {
  approvalId: string;
  decision: "approved" | "rejected";
  note?: string;
  /** Why the founder decided this, in their own words. */
  reasoning?: string;
  /** A code from the fixed reason-code taxonomy. */
  reasonCode?: string;
  /** What the founder was shown when they decided. */
  evidenceShown?: string;
}): Promise<{ ok: boolean; error?: string }> {
  await ensureOffice();
  const note = (input.note ?? "").trim();
  const givenReasoning = (input.reasoning ?? "").trim();
  const givenReasonCode = (input.reasonCode ?? "").trim();
  const givenEvidence = (input.evidenceShown ?? "").trim();

  return withChain(async (tx) => {
    const row = await tx<Record<string, unknown>>`
      select * from approvals where id = ${input.approvalId} for update
    `.then((rows) => rows[0]);
    if (!row) return { ok: false, error: "Approval not found." };
    if (String(row.status) !== "pending") {
      return { ok: false, error: "That approval has already been resolved." };
    }

    const action = parseJson<ProposedAction>(row.action_json, {
      kind: "notify_operator",
      title: String(row.title),
      rationale: String(row.rationale),
      confidence: 1,
      amountCents: num(row.amount_cents),
      payload: {},
    });
    const agentId = String(row.agent_id);
    const company = await loadCompanyTx(tx);
    const policyVersion = policyVersionOf(company);
    const risk = riskOfAction(action);
    const gate = gateOutcomeFor(action, risk);
    const companyName = row.company_name ? String(row.company_name) : null;

    // Approve: honour a halt. The governor refuses all agent action while the
    // office is halted; founder approval is the only thing that can lift that,
    // and it is not an implicit one. Refusing a queued action is always safe,
    // so a refusal is still allowed while the office is halted.
    if (input.decision === "approved" && company.halted) {
      return {
        ok: false,
        error: "The office is halted. Resume it before approving queued work.",
      };
    }

    // Section 71: a legal decision carries the founder's own reasoning, and it
    // carries it before the action is exposed. The founder's note stands in
    // for the reasoning when they wrote one, but the reason code and the
    // evidence are the founder's to give.
    let reasoning = givenReasoning;
    if (gate.legal) {
      const written = reasoning || note;
      const verdict = validatePreExposureReasoning({
        reasonCode: givenReasonCode,
        reasoning: written,
        evidenceShown: givenEvidence,
        policyVersion,
      });
      if (!verdict.ok) {
        return {
          ok: false,
          error: `${verdict.error} This decision reaches POPIA section 71, so it cannot be resolved without a reason code, your reasoning, and the evidence you were shown.`,
        };
      }
      reasoning = written;
    }

    // Tier 1–3 rulings are remembered: what was decided, and under which
    // material conditions.
    const remember = risk.tier === 1 || risk.tier === 2 || risk.tier === 3;
    const stage = remember ? await stageForDecision(tx, action, companyName) : null;

    if (input.decision === "rejected") {
      const claimed = await tx<{ id: string }>`
        update approvals
        set status = 'rejected',
            resolution_note = ${note || "Rejected by founder."},
            pre_exposure_reasoning = ${reasoning || null},
            pre_exposure_reason_code = ${givenReasonCode || null},
            evidence_shown = ${givenEvidence || null},
            decided_at = now(),
            resolved_at = now()
        where id = ${input.approvalId} and status = 'pending'
        returning id
      `;
      if (!claimed.length) return { ok: false, error: "That approval has already been resolved." };
      // Record the refusal as its own decision so the escalation does not stay
      // open forever in the autonomy metrics.
      const decisionId = await recordDecisionTx(tx, {
        agentId,
        action,
        status: "blocked",
        trace: [],
        reversibility: "fully_reversible",
        observation: { gate: "founder", decision: "rejected", approvalId: input.approvalId },
      });
      if (gate.legal) {
        await writeGateRecordTx(tx, {
          approvalId: input.approvalId,
          decisionId,
          gate,
          policyVersion,
          reasoning: reasoning || null,
          evidenceShown: givenEvidence || null,
          decided: true,
        });
      }
      if (remember) {
        await recordDecisionEpisodeTx(tx, {
          decisionId,
          action,
          companyName,
          outcome: "rejected",
          reasonCode: episodeReasonCode(givenReasonCode),
          reasoning: episodeReasoning(reasoning, note, "rejected"),
          exceptionConditions: exceptionConditionsOf(action),
          policyVersion,
          stage,
          agentId,
        });
      }
      await appendAuditTx(
        tx,
        "approval_rejected",
        String(row.title),
        note || "Founder rejected the action. It was not executed.",
        "founder",
      );
      return { ok: true };
    }

    const claimed = await tx<{ id: string }>`
      update approvals
        set status = 'approved',
            resolution_note = ${note || "Approved by founder."},
            pre_exposure_reasoning = ${reasoning || null},
            pre_exposure_reason_code = ${givenReasonCode || null},
            evidence_shown = ${givenEvidence || null},
            decided_at = now(),
            exposure_at = now(),
            resolved_at = now()
        where id = ${input.approvalId} and status = 'pending'
        returning id
    `;
    if (!claimed.length) return { ok: false, error: "That approval has already been resolved." };

    if (action.kind === "handoff_to_sales") {
      const handoffCompany = String(row.company_name ?? action.companyName ?? "Unnamed company");
      const oppId = randomUUID();
      let leadId = action.relatedId ? String(action.relatedId) : null;
      if (leadId) {
        const found = await tx<{ id: string }>`select id from leads where id = ${leadId} limit 1`;
        if (!found.length) leadId = null;
      }
      if (!leadId) {
        leadId = randomUUID();
        await tx`
          insert into leads (id, company_name, source, stage, score, summary)
          values (
            ${leadId}, ${handoffCompany}, 'marketing', 'in_sales',
            ${num(action.payload.score, 55)}, ${action.rationale}
          )
        `;
      }
      await tx`
        insert into opportunities (id, lead_id, company_name, stage, value_cents, summary, handoff_approval_id)
        values (
          ${oppId}, ${leadId}, ${handoffCompany}, 'discovery', ${action.amountCents},
          ${action.rationale}, ${input.approvalId}
        )
      `;
      await tx`update leads set stage = 'in_sales', updated_at = now() where id = ${leadId}`;
    } else {
      await executeAuthorized(tx, agentId, action, input.approvalId);
    }

    const decisionId = await recordDecisionTx(tx, {
      agentId,
      action,
      status: "executed",
      trace: [],
      reversibility: "partially_reversible",
      observation: { gate: "founder", decision: "approved", approvalId: input.approvalId },
    });
    if (gate.legal) {
      await writeGateRecordTx(tx, {
        approvalId: input.approvalId,
        decisionId,
        gate,
        policyVersion,
        reasoning: reasoning || null,
        evidenceShown: givenEvidence || null,
        decided: true,
      });
    }
    if (remember) {
      await recordDecisionEpisodeTx(tx, {
        decisionId,
        action,
        companyName,
        outcome: "approved",
        reasonCode: episodeReasonCode(givenReasonCode),
        reasoning: episodeReasoning(reasoning, note, "approved"),
        exceptionConditions: exceptionConditionsOf(action),
        policyVersion,
        stage,
        agentId,
      });
    }
    // The execution itself is signed for, against the chain head it landed on.
    if (risk.tier === 1 || risk.tier === 2 || risk.tier === 3) {
      await writeDecisionReceiptTx(tx, {
        decisionId,
        action,
        risk,
        agentId,
        approvalId: input.approvalId,
        approvedBy: "founder",
      });
    }
    await appendAuditTx(
      tx,
      "approval_approved",
      String(row.title),
      note || "Founder approved. Action executed inside the authorised envelope.",
      "founder",
    );
    return { ok: true };
  });
}

/** Log support time against an account, in whole minutes. */
export async function logServiceTime(input: {
  companyName: string;
  minutes: number;
  note: string;
  workedAt?: string;
}): Promise<{ ok: true; entry: ServiceTimeRow } | { ok: false; error: string }> {
  await ensureOffice();
  const company = input.companyName.trim().slice(0, 160);
  const minutes = Math.trunc(input.minutes);
  const note = input.note.trim().slice(0, 500);
  if (company.length < 2) return { ok: false, error: "Name the account this time belongs to." };
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    return { ok: false, error: "Enter between 1 and 1440 minutes." };
  }
  if (note.length < 3) return { ok: false, error: "Write a short note for the time entry." };
  const workedAt = input.workedAt ? new Date(`${input.workedAt}T12:00:00.000Z`) : new Date();
  if (Number.isNaN(workedAt.getTime())) return { ok: false, error: "That work date is not valid." };
  if (workedAt.getTime() > Date.now() + 86_400_000) {
    return { ok: false, error: "Work time cannot be logged in the future." };
  }
  const id = randomUUID();
  const sql = await getSql();
  await sql`
    insert into service_time_entries (id, company_name, minutes, note, worked_at)
    values (${id}, ${company}, ${minutes}, ${note}, ${workedAt.toISOString()})
  `;
  await appendAudit(
    "service_time_logged",
    `Support time · ${company}`,
    `${minutes} minute${minutes === 1 ? "" : "s"}: ${note}`,
    "founder",
  );
  return {
    ok: true,
    entry: {
      id,
      companyName: company,
      minutes,
      note,
      workedAt: workedAt.toISOString(),
      createdAt: workedAt.toISOString(),
    },
  };
}

/** Recent support-time entries, newest first. */
export async function listServiceTime(limit = 50): Promise<ServiceTimeRow[]> {
  await ensureOffice();
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from service_time_entries
    order by worked_at desc, id desc
    limit ${Math.max(1, Math.min(Math.trunc(limit) || 1, 200))}
  `;
  return rows.map((row) => ({
    id: String(row.id),
    companyName: String(row.company_name),
    minutes: num(row.minutes),
    note: String(row.note ?? ""),
    workedAt: iso(row.worked_at),
    createdAt: iso(row.created_at),
  }));
}

/**
 * Close a waiting approval without deciding it.
 *
 * A skip is not an approval and not a rejection. Nothing is executed, no
 * precedent is written, and a §71 gate record stays visibly undecided. The
 * audit entry names the act for what it was, so "no decision" cannot later be
 * read as a quiet refusal.
 */
export async function skipApproval(input: {
  approvalId: string;
  note?: string;
}): Promise<{ ok: boolean; error?: string }> {
  await ensureOffice();
  const note =
    (input.note ?? "").trim() ||
    "Skipped by the founder without an approve or reject ruling. Nothing was executed.";
  return withChain(async (tx) => {
    const row = await tx<Record<string, unknown>>`
      select id, title, status from approvals where id = ${input.approvalId} for update
    `.then((rows) => rows[0]);
    if (!row) return { ok: false, error: "Approval not found." };
    if (String(row.status) !== "pending") {
      return { ok: false, error: "That approval has already been resolved." };
    }
    const claimed = await tx<{ id: string }>`
      update approvals
        set status = 'skipped', resolution_note = ${note}, resolved_at = now()
        where id = ${input.approvalId} and status = 'pending'
        returning id
    `;
    if (!claimed.length) return { ok: false, error: "That approval has already been resolved." };
    await appendAuditTx(tx, "approval_skipped", String(row.title), note, "founder");
    return { ok: true };
  });
}

export async function setOfficeHalt(halted: boolean, reason: string): Promise<void> {
  await ensureOffice();
  const sql = await getSql();
  await sql`
    update company_state
    set halted = ${halted}, halt_reason = ${halted ? reason : null}, updated_at = now()
    where id = ${COMPANY.id}
  `;
  await sql`
    update agents set status = ${halted ? "halted" : "idle"}, current_task = ${halted ? "Halted by founder" : null}
  `;
  await appendAudit(
    halted ? "office_halt" : "office_resume",
    halted ? "Office halted" : "Office resumed",
    halted ? reason : "Founder resumed autonomous operations.",
    "founder",
  );
}

export async function logInboundItem(input: {
  channel: string;
  companyName: string;
  subject: string;
  summary: string;
  intent: string;
}): Promise<string> {
  await ensureOffice();
  const sql = await getSql();
  const id = randomUUID();
  await sql`
    insert into inbound_items (id, channel, company_name, subject, summary, intent, status)
    values (
      ${id}, ${input.channel}, ${input.companyName}, ${input.subject},
      ${input.summary}, ${input.intent}, 'received'
    )
  `;
  await appendAudit(
    "inbound_received",
    input.subject,
    `${input.channel} from ${input.companyName}: ${input.summary}`,
    "foyer",
  );
  return id;
}

export async function filePaymentNotice(input: {
  name: string;
  email: string;
  reference: string;
  amount: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = parsePaymentNotice(input);
  if (!parsed.ok) return parsed;
  const id = await logInboundItem({
    channel: "web",
    companyName: parsed.name,
    subject: `Payment notice ${parsed.reference}`,
    summary: `Email: ${input.email.trim()}\n${parsed.summary}`,
    intent: "payment_notice",
  });
  const company = await loadCompany();
  if (!company.halted) {
    await applyProposedAction(
      "foyer",
      {
        kind: "route_inbound",
        title: "Route payment notice",
        rationale: "Customer says they paid. Ledger holds the notice. No receipt is booked.",
        confidence: 0.95,
        amountCents: 0,
        companyName: parsed.name,
        relatedId: id,
        payload: { routedTo: "ledger" },
      },
      { source: "vantage-ars.co.za" },
    );
  }
  return { ok: true };
}

export async function dismissPaymentNotice(
  inboundId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const company = await loadCompany();
  if (company.halted) return { ok: false, error: "Office is halted." };
  const item = await sql<Record<string, unknown>>`
    select * from inbound_items where id = ${inboundId} and intent = 'payment_notice'
  `.then((rows) => rows[0]);
  if (!item) return { ok: false, error: "That payment notice is not on the ledger." };
  if (String(item.status) === "filed") return { ok: false, error: "This notice is already filed." };
  await sql`update inbound_items set status = 'filed' where id = ${inboundId}`;
  await appendAudit(
    "payment_notice_filed",
    String(item.subject),
    "Founder filed the payment notice. Treasury was not changed.",
    "founder",
  );
  return { ok: true };
}

export function compactState(snapshot: OfficeSnapshot): Record<string, unknown> {
  return {
    treasuryCents: snapshot.company.treasuryCents,
    receivableCents: snapshot.company.receivableCents,
    payableCents: snapshot.company.payableCents,
    halted: snapshot.company.halted,
    pendingApprovals: snapshot.approvals
      .filter((a) => a.status === "pending")
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
      })),
    inboundOpen: snapshot.inbound
      .filter((i) => i.status === "received")
      .slice(0, 8)
      .map((i) => ({
        id: i.id,
        companyName: i.companyName,
        subject: i.subject,
        intent: i.intent,
        summary: i.summary,
      })),
    leads: snapshot.leads.slice(0, 8).map((l) => ({
      id: l.id,
      companyName: l.companyName,
      stage: l.stage,
      score: l.score,
      summary: l.summary,
    })),
    opportunities: snapshot.opportunities.slice(0, 8).map((o) => ({
      id: o.id,
      companyName: o.companyName,
      stage: o.stage,
      valueCents: o.valueCents,
      summary: o.summary,
    })),
    campaigns: snapshot.campaigns.slice(0, 6).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      budgetCents: c.budgetCents,
    })),
    tickets: snapshot.tickets
      .filter((t) => t.status !== "resolved")
      .slice(0, 6)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        severity: t.severity,
        summary: t.summary,
      })),
    documents: snapshot.documents.slice(0, 6).map((d) => ({
      id: d.id,
      title: d.title,
      kind: d.kind,
      status: d.status,
    })),
    publishedRates: PUBLISHED_RATES.map((rate) => ({
      id: rate.id,
      title: rate.title,
      price: rate.price,
      offered: rate.offered,
      basis: rate.basis,
    })),
  };
}

export async function founderClose(input: {
  opportunityId: string;
  outcome: "won" | "lost";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const won = input.outcome === "won";
  return closeOpportunity({
    opportunityId: input.opportunityId,
    outcome: input.outcome,
    actor: "founder",
    note: won
      ? "Founder recorded the customer's acceptance. The quote was not emailed from here."
      : "Founder recorded that the customer declined. No email was sent.",
  });
}

/**
 * Close an opportunity on the customer's answer. Shared by the founder's
 * "Customer accepted/declined" buttons and the customer's own quote link, so
 * both follow the same rules: an approved quote must exist, and a win opens
 * exactly one delivery ticket. Nothing is invoiced or emailed here.
 *
 * Records are read straight from the database, not from `readSnapshot`. The
 * snapshot is windowed for display; using it here meant that once the office had
 * more than 40 documents or 80 tickets, an old quote became invisible and the
 * guards below silently stopped protecting the books.
 */
async function closeOpportunity(input: {
  opportunityId: string;
  outcome: "won" | "lost";
  actor: string;
  note: string;
  quoteId?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const company = await loadCompany();
  if (company.halted) return { ok: false, error: "Office is halted." };

  return withChain(async (tx) => {
    const rows = await tx<Record<string, unknown>>`
      select * from opportunities where id = ${input.opportunityId} for update
    `;
    const record = rows[0];
    if (!record) return { ok: false, error: "That opportunity is not on the pipeline." };
    const stage = String(record.stage);
    if (stage === "won" || stage === "lost") {
      return { ok: false, error: "This opportunity is already closed." };
    }
    const companyName = String(record.company_name);
    const valueCents = num(record.value_cents);

    const quotes = await tx<Record<string, unknown>>`
      select id, summary from documents
      where kind = 'quote' and status = 'approved_unsent' and related_id = ${input.opportunityId}
      order by created_at desc
      limit 5
    `;
    const quote = input.quoteId
      ? quotes.find((row) => String(row.id) === input.quoteId)
      : quotes[0];
    if (!quote) {
      return { ok: false, error: "Approve a quote before recording the customer's answer." };
    }

    const won = input.outcome === "won";
    if (won && valueCents <= 0) {
      return { ok: false, error: "There is no approved figure to accept." };
    }
    const note = input.note;
    await tx`
      update opportunities
      set stage = ${won ? "won" : "lost"},
          summary = ${`${note} ${String(record.summary)}`},
          updated_at = now()
      where id = ${input.opportunityId}
    `;
    await tx`
      update documents
      set status = ${won ? "accepted" : "declined"},
          accepted_at = ${won ? new Date().toISOString() : null}
      where id = ${quote.id}
    `;
    if (won) {
      // `not exists` in the insert makes the delivery ticket idempotent even if
      // the customer clicks accept twice.
      const opened = await tx<{ id: string }>`
        insert into tickets (id, title, severity, status, owner_agent, summary, related_id)
        select ${randomUUID()}, ${deliveryJob(companyName, String(quote.summary)).title}, 'p3',
               'open', 'forge', ${deliveryJob(companyName, String(quote.summary)).summary},
               ${input.opportunityId}
        where not exists (
          select 1 from tickets where related_id = ${input.opportunityId}
        )
        returning id
      `;
      void opened;
    }
    await appendAuditTx(
      tx,
      won ? "customer_accepted" : "customer_declined",
      companyName,
      note,
      input.actor,
    );
    return { ok: true };
  });
}

// ── Customer quote links ─────────────────────────────────────────────────────

export type PublicQuote =
  | {
      ok: true;
      state: QuoteLinkState;
      companyName: string;
      amountCents: number;
      scope: string;
      reference: string | null;
      paymentNote: string;
      issuedAt: string;
      expiresAt: string;
      answeredAt: string | null;
      answerName: string | null;
    }
  | { ok: false; error: string };

function tokenHash(token: string): string {
  return sha256Hex(`quote-link:${token}`);
}

/**
 * Create a link for an approved quote, inside a caller's transaction.
 *
 * Split out from the founder-facing wrapper so the office can create a link
 * for a quote it issued itself, in the same transaction that records the
 * action — no nested advisory lock, no half-written notice.
 */
async function createQuoteLinkTx(
  tx: Sql,
  documentId: string,
  options: { actor: string; revokeExisting: boolean },
): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; error: string }> {
  const quote = await tx<Record<string, unknown>>`
    select d.*, o.stage as opportunity_stage, o.company_name as opportunity_company
    from documents d
    left join opportunities o on o.id = d.related_id
    where d.id = ${documentId} and d.kind = 'quote'
  `.then((rows) => rows[0]);
  if (!quote || String(quote.status) !== "approved_unsent" || !quote.related_id) {
    return {
      ok: false,
      error: "Only an approved quote that is waiting on the customer can get a link.",
    };
  }
  const stage = String(quote.opportunity_stage ?? "");
  if (stage === "won" || stage === "lost") {
    return { ok: false, error: "This opportunity is already closed." };
  }
  const opportunityId = String(quote.related_id);
  const opportunityCompany = String(quote.opportunity_company ?? "Customer");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = linkExpiry().toISOString();
  if (options.revokeExisting) {
    await tx`
      update quote_links set revoked_at = now()
      where document_id = ${String(quote.id)} and revoked_at is null and answered_at is null
    `;
  }
  await tx`
    insert into quote_links (id, token_hash, document_id, opportunity_id, expires_at)
    values (${randomUUID()}, ${tokenHash(token)}, ${String(quote.id)}, ${opportunityId}, ${expiresAt})
  `;
  await appendAuditTx(
    tx,
    "quote_link_created",
    opportunityCompany,
    `Customer quote link created, valid until ${expiresAt.slice(0, 10)}. ${
      options.revokeExisting
        ? "Any earlier link for this quote was revoked."
        : "Earlier links for this quote were left in place."
    } Nothing was emailed by this action alone.`,
    options.actor,
  );
  return { ok: true, token, expiresAt };
}

/** Founder: create a fresh link for an approved quote. Older links for it stop working. */
export async function createQuoteLink(
  documentId: string,
): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; error: string }> {
  const company = await loadCompany();
  if (company.halted) return { ok: false, error: "Office is halted." };
  return withChain((tx) =>
    createQuoteLinkTx(tx, documentId, { actor: "founder", revokeExisting: true }),
  );
}

/** Founder: stop every open link for a quote. */
export async function revokeQuoteLinks(
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    update quote_links set revoked_at = now()
    where document_id = ${documentId} and revoked_at is null and answered_at is null
    returning id
  `;
  if (rows.length === 0) return { ok: false, error: "There is no open link for this quote." };
  const quote = await sql<{
    title: string;
  }>`select title from documents where id = ${documentId}`.then((found) => found[0]);
  await appendAudit(
    "quote_link_revoked",
    quote?.title ?? "Quote",
    "Customer quote link revoked by the founder.",
    "founder",
  );
  return { ok: true };
}

/** Founder: the latest link per quote, for the Sales page. */
export async function listQuoteLinks(): Promise<QuoteLinkSummary[]> {
  const sql = await getSql();
  // One row per quote via DISTINCT ON instead of pulling every historical link
  // into memory and de-duplicating in JS.
  const rows = await sql<Record<string, unknown>>`
    select distinct on (l.document_id)
      l.document_id, l.expires_at, l.revoked_at, l.answer, l.answer_name, l.answer_note,
      l.created_at, l.first_viewed_at, l.last_viewed_at, l.view_count, l.answered_at,
      d.status as document_status
    from quote_links l
    join documents d on d.id = l.document_id
    order by l.document_id, l.created_at desc
  `;
  return rows.map((row) => {
    const documentId = String(row.document_id);
    const record = {
      expiresAt: iso(row.expires_at),
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
      answer: row.answer ? String(row.answer) : null,
    };
    return {
      documentId,
      state: linkState(record, String(row.document_status)),
      createdAt: iso(row.created_at),
      expiresAt: record.expiresAt,
      firstViewedAt: row.first_viewed_at ? iso(row.first_viewed_at) : null,
      lastViewedAt: row.last_viewed_at ? iso(row.last_viewed_at) : null,
      viewCount: num(row.view_count),
      answeredAt: row.answered_at ? iso(row.answered_at) : null,
      answerName: row.answer_name ? String(row.answer_name) : null,
      answerNote: row.answer_note ? String(row.answer_note) : null,
    };
  });
}

async function findLink(token: string): Promise<Record<string, unknown> | null> {
  if (!plausibleToken(token)) return null;
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from quote_links where token_hash = ${tokenHash(token)} limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Public: what the customer sees on their link. Records the view.
 *
 * Reads only the three rows it needs. This used to call `readSnapshot`, which
 * meant an unauthenticated request to `/q/<token>` fired ~30 queries including
 * every table in the office — a free denial-of-service surface and a slow page.
 */
export async function readPublicQuote(token: string, countView = true): Promise<PublicQuote> {
  const link = await findLink(token);
  if (!link) return { ok: false, error: "This quote link is not valid. Ask us for a new one." };
  const sql = await getSql();

  const joined = await sql<Record<string, unknown>>`
    select
      d.status        as document_status,
      d.summary       as document_summary,
      d.created_at    as issued_at,
      o.company_name  as company_name,
      o.value_cents   as value_cents
    from documents d
    join opportunities o on o.id = d.related_id
    where d.id = ${String(link.document_id)}
    limit 1
  `.then((rows) => rows[0]);
  if (!joined)
    return { ok: false, error: "This quote is no longer on file. Ask us for a new one." };

  const record = {
    expiresAt: iso(link.expires_at),
    revokedAt: link.revoked_at ? iso(link.revoked_at) : null,
    answer: link.answer ? String(link.answer) : null,
  };
  const state = linkState(record, String(joined.document_status));
  if (state === "revoked") {
    return {
      ok: false,
      error: "This quote link was replaced or withdrawn. Ask us for the current one.",
    };
  }
  if (countView && state === "open") {
    await sql`
      update quote_links
      set view_count = view_count + 1,
          first_viewed_at = coalesce(first_viewed_at, now()),
          last_viewed_at = now()
      where id = ${String(link.id)} and answered_at is null
    `;
  }

  const company = await loadCompany();
  const scope = customerQuoteText(String(joined.document_summary));
  return {
    ok: true,
    state,
    companyName: String(joined.company_name),
    amountCents: num(joined.value_cents),
    scope,
    reference: scope.match(/Reference:\s*(VA-[A-Z0-9]+)/)?.[1] ?? null,
    paymentNote: paymentNote(company.paymentInstructions),
    issuedAt: iso(joined.issued_at),
    expiresAt: record.expiresAt,
    answeredAt: link.answered_at ? iso(link.answered_at) : null,
    answerName: link.answer_name ? String(link.answer_name) : null,
  };
}

/** Public: the customer accepts or declines on their link. */
export async function answerPublicQuote(
  token: string,
  answer: { outcome: "accepted" | "declined"; name: string; note: string },
): Promise<{ ok: true; companyName: string; amountCents: number } | { ok: false; error: string }> {
  const link = await findLink(token);
  if (!link) return { ok: false, error: "This quote link is not valid. Ask us for a new one." };
  const view = await readPublicQuote(token, false);
  if (!view.ok) return view;
  if (view.state !== "open") {
    const why: Record<string, string> = {
      accepted: "This quote was already accepted.",
      declined: "This quote was already declined.",
      expired: "This quote link has expired. Ask us for a fresh quote.",
      closed: "This quote is closed. Ask us for a fresh quote.",
    };
    return { ok: false, error: why[view.state] ?? "This quote can no longer be answered." };
  }
  const sql = await getSql();
  // Claim the link first so a double click cannot record two answers.
  const claimed = await sql<{ id: string }>`
    update quote_links
    set answered_at = now(), answer = ${answer.outcome}, answer_name = ${answer.name}, answer_note = ${answer.note || null}
    where id = ${String(link.id)} and answered_at is null and revoked_at is null
    returning id
  `;
  if (claimed.length === 0) return { ok: false, error: "This quote was already answered." };
  const won = answer.outcome === "accepted";
  const note = won
    ? `Customer accepted on their quote link as "${answer.name}".${answer.note ? ` Note: ${answer.note}` : ""}`
    : `Customer declined on their quote link as "${answer.name}".${answer.note ? ` Note: ${answer.note}` : ""}`;
  const closed = await closeOpportunity({
    opportunityId: String(link.opportunity_id),
    outcome: won ? "won" : "lost",
    actor: "customer",
    note,
    quoteId: String(link.document_id),
  });
  if (!closed.ok) {
    await sql`update quote_links set answered_at = null, answer = null, answer_name = null, answer_note = null where id = ${String(link.id)}`;
    return closed;
  }
  return { ok: true, companyName: view.companyName, amountCents: view.amountCents };
}

export async function raiseQuoteInvoice(
  opportunityId: string,
  vatTreatment: VatTreatment = "none",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const company = await loadCompany();
  if (company.halted) return { ok: false, error: "Office is halted." };
  const record = await sql<Record<string, unknown>>`
    select * from opportunities where id = ${opportunityId}
  `.then((rows) => rows[0]);
  if (!record || String(record.stage) !== "won") {
    return { ok: false, error: "Invoice only after the customer has accepted." };
  }
  const opportunityCompany = String(record.company_name);
  const treatment = parseVatTreatment(vatTreatment);
  // Invoice the figure the customer accepted, not the opportunity's current
  // value (which a later stage update can overwrite). Old quotes written before
  // amounts were snapshotted fall back to the opportunity.
  const accepted = await sql<{ amount_cents: number | null }>`
    select amount_cents from documents
    where kind = 'quote' and status = 'accepted' and related_id = ${opportunityId}
    order by coalesce(accepted_at, created_at) desc
    limit 1
  `.then((rows) => rows[0]);
  const acceptedCents = num(accepted?.amount_cents) || num(record.value_cents);
  const figure = quoteInvoice(acceptedCents, treatment);
  if (!figure.ok) return figure;

  // Guard against a double submit booking two invoices. This must query the whole
  // table, not a window of the 80 most recent ledger rows.
  const existing = await sql<{ id: string }>`
    select id from ledger_entries where kind = 'invoice' and related_id = ${opportunityId} limit 1
  `;
  if (existing.length)
    return { ok: false, error: "An invoice is already on the books for this job." };

  const result = await applyProposedAction(
    "ledger",
    {
      kind: "issue_invoice",
      title: `Invoice · ${opportunityCompany}`,
      rationale: figure.memo,
      confidence: 0.95,
      amountCents: figure.cents,
      companyName: opportunityCompany,
      relatedId: opportunityId,
      payload: { vatTreatment: treatment, vatCents: figure.vatCents },
    },
    { source: "ledger-desk" },
  );
  if (result.status !== "executed") {
    return { ok: false, error: result.error ?? "The invoice was not raised." };
  }

  const docId = randomUUID();
  const text = invoiceCopy(opportunityCompany, figure.cents, documentRef(docId), {
    treatment,
    netCents: figure.netCents,
    vatCents: figure.vatCents,
  });
  await sql`
    insert into documents (id, title, kind, status, summary, related_id)
    select ${docId}, ${`Invoice · ${opportunityCompany}`}, 'invoice', 'approved_unsent', ${text}, ${opportunityId}
    where not exists (
      select 1 from documents where kind = 'invoice' and related_id = ${opportunityId}
    )
  `;
  return { ok: true };
}

export async function recordInvoiceReceipt(
  invoiceId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const company = await loadCompany();
  if (company.halted) return { ok: false, error: "Office is halted." };
  const record = await sql<Record<string, unknown>>`
    select * from ledger_entries where id = ${invoiceId} and kind = 'invoice'
  `.then((rows) => rows[0]);
  if (!record || String(record.status) !== "issued") {
    return { ok: false, error: "That invoice is not awaiting payment." };
  }
  const counterparty = String(record.counterparty);
  const figure = receiptForInvoice(num(record.amount_cents));
  if (!figure.ok) return figure;

  // Whole-table guard: crediting treasury twice is how money appears from
  // nothing, so this must never depend on a windowed read.
  const already = await sql<{ id: string }>`
    select id from ledger_entries where kind = 'receipt' and related_id = ${invoiceId} limit 1
  `;
  if (already.length)
    return { ok: false, error: "A receipt is already recorded for this invoice." };

  const result = await applyProposedAction(
    "ledger",
    {
      kind: "record_inbound_payment",
      title: `Receipt · ${counterparty}`,
      rationale: figure.memo,
      confidence: 0.95,
      amountCents: figure.cents,
      companyName: counterparty,
      relatedId: invoiceId,
      payload: {},
    },
    { source: "ledger-desk" },
  );
  if (result.status !== "executed") {
    return { ok: false, error: result.error ?? "The receipt was not recorded." };
  }
  // The money movement, invoice status, cycle status and receipt document are
  // written inside the action transaction. Only the human-readable audit note
  // is added afterwards.
  await appendAudit("payment_received", counterparty, figure.memo, "founder");
  return { ok: true };
}

export async function setTicketStatus(
  ticketId: string,
  status: "in_progress" | "resolved",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const company = await loadCompany();
  if (company.halted) return { ok: false, error: "Office is halted." };
  const record = await sql<Record<string, unknown>>`
    select * from tickets where id = ${ticketId}
  `.then((rows) => rows[0]);
  if (!record) return { ok: false, error: "That ticket is not on the floor." };
  const next = status === "resolved" ? "resolved" : "in_progress";
  const allowed = nextTicketStatus(String(record.status), next);
  if (!allowed.ok) return allowed;
  await sql`update tickets set status = ${next}, updated_at = now() where id = ${ticketId}`;
  const note =
    next === "resolved"
      ? "Founder marked the work resolved. The customer was not emailed."
      : "Founder started the work. The customer was not emailed.";
  await appendAudit(
    next === "resolved" ? "ticket_resolved" : "ticket_started",
    String(record.title),
    note,
    "founder",
  );
  return { ok: true };
}

export async function savePaymentInstructions(
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const snapshot = await readSnapshot();
  if (snapshot.company.halted) return { ok: false, error: "Office is halted." };
  const note = paymentNote(text);
  const sql = await getSql();
  await sql`
    update company_state
    set payment_instructions = ${note}, updated_at = now()
    where id = ${COMPANY.id}
  `;
  await appendAudit(
    "payment_instructions",
    "Payment instructions",
    note
      ? "Founder set how customers should pay. Nothing was emailed."
      : "Founder cleared the payment instructions.",
    "founder",
  );
  return { ok: true };
}

export type { DispatchResult, ActionKind };

export async function exportBackupJson(): Promise<string> {
  const { BACKUP_TABLES, buildBackup } = await import("./backup");
  const sql = await getSql();
  const tables: Record<string, Record<string, unknown>[]> = {};
  await Promise.all(
    BACKUP_TABLES.map(async (name) => {
      // Names come from a fixed list in backup.ts, never from user input.
      tables[name] = await sql.query<Record<string, unknown>>(`select * from ${name}`);
    }),
  );
  return JSON.stringify(buildBackup(tables));
}

export async function restoreBackupJson(
  json: string,
): Promise<{ ok: true; added: Record<string, number> } | { ok: false; error: string }> {
  const { BACKUP_RESTORE_ORDER, MAX_RESTORE_BYTES, planRestore } = await import("./backup");
  if (typeof json !== "string" || json.length === 0) {
    return { ok: false, error: "The backup file is empty." };
  }
  // Measure BYTES, not UTF-16 code units: `json.length` under-counts non-ASCII by
  // up to 3x, so the old guard could admit a 12 MB body.
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_RESTORE_BYTES) {
    return {
      ok: false,
      error: `The backup file is ${(bytes / 1_000_000).toFixed(1)} MB. The limit is ${(MAX_RESTORE_BYTES / 1_000_000).toFixed(0)} MB.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "That file is not valid JSON." };
  }
  const sql = await getSql();
  const names = Object.keys(
    (parsed as { tables?: Record<string, unknown> } | null)?.tables ?? {},
  ).filter((n) => /^[a-z_]+$/.test(n));
  const columnsByTable = await Promise.all(
    names.map(async (name) => {
      const rows = await sql<{ column_name: string }>`
        select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = ${name}
      `;
      return [name, rows.map((row) => row.column_name)] as const;
    }),
  );
  const plan = planRestore(parsed, Object.fromEntries(columnsByTable));
  if (!plan.ok) return plan;

  const added: Record<string, number> = {};
  const ordered = [...plan.tables].sort(
    (a, b) => BACKUP_RESTORE_ORDER.indexOf(a.name) - BACKUP_RESTORE_ORDER.indexOf(b.name),
  );
  // One transaction for the whole restore: a half-restored office is worse than
  // one that refused the file.
  await withChain(async (tx) => {
    for (const table of ordered) {
      // table.name passed the fixed allow-list in planRestore; it is never raw user input.
      const result = await tx.query<{ n: number }>(
        `with ins as (
           insert into ${table.name}
           select * from jsonb_populate_recordset(null::${table.name}, $1::jsonb)
           on conflict do nothing
           returning 1
         ) select count(*)::int as n from ins`,
        [JSON.stringify(table.rows)],
      );
      added[table.name] = Number(result[0]?.n ?? 0);
    }
    await appendAuditTx(
      tx,
      "backup_restored",
      "Backup restored",
      `Add-only restore applied. Tables and rows added: ${
        Object.entries(added)
          .filter(([, n]) => n > 0)
          .map(([name, n]) => `${name} ${n}`)
          .join(", ") || "nothing (everything already existed)"
      }. Nothing was deleted or overwritten.`,
      "founder",
    );
  });
  return { ok: true, added };
}

// ── Subscriptions and recurring revenue ───────────────────────────────────────

function mapSubscription(row: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(row.id),
    companyName: String(row.company_name),
    contactName: row.contact_name ? String(row.contact_name) : null,
    contactEmail: row.contact_email ? String(row.contact_email) : null,
    planId: String(row.plan_id),
    rateId: String(row.rate_id),
    cycle: String(row.cycle),
    priceCents: num(row.price_cents),
    status: (String(row.status) as SubscriptionRow["status"]) || "active",
    opportunityId: row.opportunity_id ? String(row.opportunity_id) : null,
    quoteDocumentId: row.quote_document_id ? String(row.quote_document_id) : null,
    startedAt: iso(row.started_at),
    nextBillingAt: iso(row.next_billing_at),
    cancelledAt: row.cancelled_at ? iso(row.cancelled_at) : null,
    cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapBillingCycle(row: Record<string, unknown>): BillingCycleRow {
  return {
    id: String(row.id),
    subscriptionId: String(row.subscription_id),
    companyName: String(row.company_name),
    planId: String(row.plan_id),
    rateId: String(row.rate_id),
    periodStart: iso(row.period_start),
    periodEnd: iso(row.period_end),
    amountCents: num(row.amount_cents),
    status: (String(row.status) as BillingCycleRow["status"]) || "pending",
    invoiceId: row.invoice_id ? String(row.invoice_id) : null,
    documentId: row.document_id ? String(row.document_id) : null,
    reportDocumentId: row.report_document_id ? String(row.report_document_id) : null,
    noticeDocumentId: row.notice_document_id ? String(row.notice_document_id) : null,
    createdAt: iso(row.created_at),
    fulfilledAt: row.fulfilled_at ? iso(row.fulfilled_at) : null,
    notifiedAt: row.notified_at ? iso(row.notified_at) : null,
    paidAt: row.paid_at ? iso(row.paid_at) : null,
  };
}

/** The recurring-revenue book. */
export async function listSubscriptions(): Promise<SubscriptionRow[]> {
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from subscriptions order by created_at desc limit 200
  `;
  return rows.map(mapSubscription);
}

/** The billing ledger: one row per period of every subscription. */
export async function listBillingCycles(limit = 120): Promise<BillingCycleRow[]> {
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from billing_cycles order by created_at desc limit ${Math.max(1, Math.min(limit, 500))}
  `;
  return rows.map(mapBillingCycle);
}

/**
 * The customer book.
 *
 * Every company the office has touched is assembled from its own records:
 * enquiries, leads, opportunities, invoices, receipts and subscriptions. It
 * is a read-only view and does not invent a client where only a page view
 * exists.
 */
export async function listCustomerAccounts(now = new Date()): Promise<CustomerBook> {
  await ensureOffice();
  const sql = await getSql();
  const [activityRows, ledgerRows, planRows] = await Promise.all([
    sql<Record<string, unknown>>`
      select company_name, 'inbound' as source, 'received' as stage,
        0::int as score, 0::int as value_cents,
        created_at, created_at as updated_at
      from inbound_items
      where btrim(company_name) <> ''
      union all
      select company_name, 'lead' as source, stage,
        score::int as score, 0::int as value_cents,
        created_at, updated_at
      from leads
      where btrim(company_name) <> ''
      union all
      select company_name, 'opportunity' as source, stage,
        0::int as score, value_cents::int as value_cents,
        created_at, updated_at
      from opportunities
      where btrim(company_name) <> ''
    `,
    sql<Record<string, unknown>>`
      select counterparty as company_name, kind, amount_cents, status, created_at
      from ledger_entries
      where kind in ('invoice', 'receipt') and btrim(counterparty) <> ''
    `,
    sql<Record<string, unknown>>`
      select company_name, contact_name, contact_email, plan_id, cycle,
        price_cents, status, next_billing_at, created_at
      from subscriptions
      where btrim(company_name) <> ''
    `,
  ]);

  const activity: CustomerActivity[] = activityRows.map((row) => ({
    companyName: String(row.company_name ?? ""),
    source: String(row.source) as CustomerActivitySource,
    stage: String(row.stage ?? ""),
    score: num(row.score),
    valueCents: num(row.value_cents),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }));
  const ledger: CustomerLedgerRow[] = ledgerRows.map((row) => ({
    companyName: String(row.company_name ?? ""),
    kind: String(row.kind ?? ""),
    amountCents: num(row.amount_cents),
    status: String(row.status ?? ""),
    createdAt: iso(row.created_at),
  }));
  const plans: CustomerPlanRow[] = planRows.map((row) => ({
    companyName: String(row.company_name ?? ""),
    contactName: row.contact_name ? String(row.contact_name) : null,
    contactEmail: row.contact_email ? String(row.contact_email) : null,
    planId: String(row.plan_id ?? ""),
    cycle: String(row.cycle ?? ""),
    priceCents: num(row.price_cents),
    status: String(row.status ?? ""),
    nextBillingAt: iso(row.next_billing_at),
    createdAt: iso(row.created_at),
  }));

  return buildCustomerBook({
    activity,
    ledger,
    plans,
    nowIso: Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString(),
  });
}

/**
 * Public site signals.
 *
 * Reads only what the store has already recorded from a real visit. There is
 * no finger-printing here: no IP address, no cookie, no inferred identity.
 * The raw event stream is bounded, so the panel reports the recorded window
 * honestly rather than pretending it is an exhaustive analytics warehouse.
 */
export async function listSiteSignals(days = 30): Promise<SiteSignals> {
  await ensureOffice();
  const sql = await getSql();
  const range = Math.max(1, Math.min(Math.round(days), 90));
  const since = new Date(Date.now() - range * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sql<Record<string, unknown>>`
    select kind, path, referrer, country, occurred_at
    from site_events
    where occurred_at >= ${since}
    order by occurred_at desc
    limit 5000
  `;
  return summarizeSiteSignals(
    rows.map((row) => ({
      kind: String(row.kind ?? ""),
      path: String(row.path ?? "/"),
      referrer: row.referrer ? String(row.referrer) : null,
      country: row.country ? String(row.country) : null,
      occurredAt: iso(row.occurred_at),
    })),
    new Date().toISOString(),
    range,
  );
}

/**
 * The recurring-revenue picture.
 *
 * MRR is the sum of the monthly value of every active subscription. A
 * quarterly plan contributes a third of its price, because that is what it
 * earns in a month. One-off work is not recurring revenue and is reported
 * separately.
 */
export async function revenueMetrics(): Promise<RevenueMetrics> {
  const sql = await getSql();
  const subs = await sql<Record<string, unknown>>`
    select plan_id, cycle, price_cents, status from subscriptions
  `;
  const active = subs.filter((row) => String(row.status) === "active");
  const paused = subs.filter((row) => String(row.status) === "paused");
  const cancelled = subs.filter((row) => String(row.status) === "cancelled");

  let monthly = 0;
  let annual = 0;
  const mix = new Map<string, { subscriptions: number; monthlyCents: number }>();
  for (const row of active) {
    const price = num(row.price_cents);
    const cycle = String(row.cycle);
    const months = cycle === "quarterly" ? 3 : cycle === "monthly" ? 1 : 0;
    const monthlyCents = months === 0 ? 0 : Math.round(price / months);
    monthly += monthlyCents;
    annual += months === 0 ? 0 : Math.round((price * 12) / months);
    const key = String(row.plan_id);
    const entry = mix.get(key) ?? { subscriptions: 0, monthlyCents: 0 };
    entry.subscriptions += 1;
    entry.monthlyCents += monthlyCents;
    mix.set(key, entry);
  }

  const month = new Date().toISOString().slice(0, 7);
  const billed = await sql<{ cents: number }>`
    select coalesce(sum(amount_cents), 0)::int as cents
    from ledger_entries
    where kind = 'invoice' and to_char(created_at, 'YYYY-MM') = ${month}
  `.then((rows) => num(rows[0]?.cents));
  const collected = await sql<{ cents: number }>`
    select coalesce(sum(amount_cents), 0)::int as cents
    from ledger_entries
    where kind = 'receipt' and to_char(created_at, 'YYYY-MM') = ${month}
  `.then((rows) => num(rows[0]?.cents));

  const outstanding = await sql<{ cents: number }>`
    select coalesce(sum(l.amount_cents), 0)::int as cents
    from ledger_entries l
    where l.kind = 'invoice' and l.status = 'issued'
  `.then((rows) => num(rows[0]?.cents));
  const overdue = await sql<{ cents: number }>`
    select coalesce(sum(amount_cents), 0)::int as cents
    from ledger_entries
    where kind = 'invoice' and status = 'issued' and created_at < now() - interval '7 days'
  `.then((rows) => num(rows[0]?.cents));

  const churn = await sql<{ n: number }>`
    select count(*)::int as n from subscriptions
    where status = 'active' and next_billing_at < now() - interval '14 days'
  `.then((rows) => num(rows[0]?.n));

  const aging = await sql<{
    current_cents: number;
    days_8_30_cents: number;
    days_31_60_cents: number;
    over_60_cents: number;
  }>`
    select
      coalesce(sum(case when created_at > now() - interval '7 days' then amount_cents else 0 end), 0)::int as current_cents,
      coalesce(sum(case when created_at <= now() - interval '7 days' and created_at > now() - interval '30 days' then amount_cents else 0 end), 0)::int as days_8_30_cents,
      coalesce(sum(case when created_at <= now() - interval '30 days' and created_at > now() - interval '60 days' then amount_cents else 0 end), 0)::int as days_31_60_cents,
      coalesce(sum(case when created_at <= now() - interval '60 days' then amount_cents else 0 end), 0)::int as over_60_cents
    from ledger_entries
    where kind = 'invoice' and status = 'issued'
  `.then((rows) => rows[0]);

  const upcomingRenewals = await sql<Record<string, unknown>>`
    select id, company_name, plan_id, price_cents, next_billing_at
    from subscriptions
    where status = 'active'
    order by next_billing_at asc
    limit 8
  `;

  const oneOff = await sql<{ cents: number }>`
    select coalesce(sum(value_cents), 0)::int as cents
    from opportunities
    where stage = 'proposal'
  `.then((rows) => num(rows[0]?.cents));

  return {
    activeSubscriptions: active.length,
    pausedSubscriptions: paused.length,
    cancelledSubscriptions: cancelled.length,
    monthlyRecurringCents: monthly,
    annualRecurringCents: annual,
    oneOffPipelineCents: oneOff,
    billedThisMonthCents: billed,
    collectedThisMonthCents: collected,
    outstandingCents: outstanding,
    overdueCents: overdue,
    churnRiskCount: churn,
    aging: {
      currentCents: num(aging?.current_cents),
      days8To30Cents: num(aging?.days_8_30_cents),
      days31To60Cents: num(aging?.days_31_60_cents),
      over60Cents: num(aging?.over_60_cents),
    },
    upcomingRenewals: upcomingRenewals.map((row) => ({
      subscriptionId: String(row.id),
      companyName: String(row.company_name ?? ""),
      planId: String(row.plan_id ?? ""),
      priceCents: num(row.price_cents),
      nextBillingAt: iso(row.next_billing_at),
    })),
    planMix: [...mix.entries()].map(([planId, entry]) => {
      const plan = planById(planId);
      return {
        planId,
        title: plan?.title ?? planId,
        subscriptions: entry.subscriptions,
        monthlyCents: entry.monthlyCents,
      };
    }),
  };
}

/** An invoice the office can match a payment notice against. */
export type MatchedInvoice = {
  id: string;
  amountCents: number;
  companyName: string;
  relatedId: string | null;
};

/**
 * Find the invoice a payment notice refers to.
 *
 * The reference on a notice is the document reference the customer was given
 * (`VA-…`). Only an invoice that is still issued, and that matches the
 * reference exactly, can be matched. The whole table is searched: a windowed
 * read would miss an old invoice and quietly stop reconciling.
 */
export async function findInvoiceForReference(reference: string): Promise<MatchedInvoice | null> {
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    amount_cents: number;
    counterparty: string;
    related_id: string;
  }>`
    select l.id, l.amount_cents, l.counterparty, l.related_id
    from ledger_entries l
    join documents d on d.related_id = l.related_id and d.kind = 'invoice'
    where l.kind = 'invoice' and l.status = 'issued'
      and d.summary like ${`%${reference}%`}
    limit 5
  `;
  if (rows.length !== 1) return null;
  const row = rows[0];
  return {
    id: String(row.id),
    amountCents: num(row.amount_cents),
    companyName: String(row.counterparty),
    relatedId: row.related_id ? String(row.related_id) : null,
  };
}

/** Mark a billing cycle as paid, once the receipt is on the books. */
export async function markCyclePaid(relatedId: string): Promise<void> {
  const sql = await getSql();
  await sql`
    update billing_cycles
    set status = 'paid', paid_at = now()
    where (id = ${relatedId} or invoice_id = ${relatedId}) and status <> 'paid'
  `;
}

/**
 * Start a subscription on the founder's instruction.
 *
 * The first period was the quote the customer accepted. The subscription
 * starts the period after it, so nobody is billed twice for the same month.
 */
export async function startSubscriptionForOpportunity(
  opportunityId: string,
  planId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const opportunity = await sql<{ id: string; company_name: string; stage: string }>`
    select id, company_name, stage from opportunities where id = ${opportunityId} limit 1
  `.then((rows) => rows[0]);
  if (!opportunity) return { ok: false, error: "That opportunity is not on the pipeline." };
  if (opportunity.stage !== "won") {
    return { ok: false, error: "Only a job the customer has won can start a subscription." };
  }
  const plan = planById(planId);
  if (!plan) return { ok: false, error: "That is not a productised service." };
  const existing = await sql<{ id: string }>`
    select id from subscriptions
    where opportunity_id = ${opportunityId} and status <> 'cancelled'
    limit 1
  `;
  if (existing.length) return { ok: false, error: "That job already has a subscription." };

  const quote = await sql<{ id: string; accepted_at: string | null; created_at: string }>`
    select id, accepted_at, created_at from documents
    where kind = 'quote' and status = 'accepted' and related_id = ${opportunityId}
    order by coalesce(accepted_at, created_at) desc limit 1
  `.then((rows) => rows[0]);
  // Bill from the moment the customer accepted, not the day the quote was
  // written. A quote accepted weeks later must not create a period that began
  // before the customer agreed to it.
  const acceptedAt = quote?.accepted_at
    ? iso(quote.accepted_at)
    : quote?.created_at
      ? iso(quote.created_at)
      : new Date().toISOString();
  const periodStart = nextCycleStart(acceptedAt, plan.cycle);
  const { email, name } = await resolveRecipient(sql, String(opportunity.company_name));

  const result = await applyProposedAction(
    "ledger",
    {
      kind: "start_subscription",
      title: `Subscription · ${opportunity.company_name} · ${plan.title}`,
      rationale: `The founder started the ${plan.title} for ${opportunity.company_name}, billing from ${periodStart.slice(0, 10)}.`,
      confidence: 0.98,
      amountCents: 0,
      companyName: String(opportunity.company_name),
      relatedId: opportunityId,
      payload: {
        planId: plan.id,
        rateId: plan.rateId,
        cycle: plan.cycle,
        priceCents: plan.priceCents,
        periodStart,
        opportunityId,
        quoteDocumentId: quote?.id ?? null,
        contactEmail: email ?? null,
        contactName: name ?? null,
      },
    },
    { source: "founder" },
  );
  if (result.status === "executed") return { ok: true };
  return { ok: false, error: `The subscription was not started: ${result.status}.` };
}

/** End a subscription. A customer outcome is a founder decision. */
export async function cancelSubscriptionById(
  subscriptionId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sql = await getSql();
  const sub = await sql<{ id: string; company_name: string; status: string }>`
    select id, company_name, status from subscriptions where id = ${subscriptionId} limit 1
  `.then((rows) => rows[0]);
  if (!sub) return { ok: false, error: "That subscription is not on file." };
  if (sub.status === "cancelled")
    return { ok: false, error: "That subscription is already ended." };
  const result = await applyProposedAction(
    "desk",
    {
      kind: "cancel_subscription",
      title: `End subscription · ${sub.company_name}`,
      rationale: reason.replace(/\s+/g, " ").trim().slice(0, 400) || "Ended by the founder.",
      confidence: 0.98,
      amountCents: 0,
      companyName: String(sub.company_name),
      relatedId: subscriptionId,
      payload: { reason: reason.replace(/\s+/g, " ").trim().slice(0, 400) },
    },
    { source: "founder" },
  );
  if (result.status === "executed") return { ok: true };
  return { ok: false, error: `The subscription was not ended: ${result.status}.` };
}

/** Every customer email the office has prepared or sent. */
export async function listCustomerNotices(): Promise<
  {
    id: string;
    companyName: string | null;
    template: string;
    recipient: string;
    subject: string;
    status: string;
    detail: string | null;
    createdAt: string;
    sentAt: string | null;
  }[]
> {
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select id, company_name, template, recipient, subject, status, detail, created_at, sent_at
    from customer_notices order by created_at desc limit 200
  `;
  return rows.map((row) => ({
    id: String(row.id),
    companyName: row.company_name ? String(row.company_name) : null,
    template: String(row.template),
    recipient: String(row.recipient),
    subject: String(row.subject),
    status: String(row.status),
    detail: row.detail ? String(row.detail) : null,
    createdAt: iso(row.created_at),
    sentAt: row.sent_at ? iso(row.sent_at) : null,
  }));
}
