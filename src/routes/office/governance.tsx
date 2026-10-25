import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/office/empty-state";
import { PageHeader } from "@/components/office/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getGovernanceRecord, getCostCeilings, saveCostCeilings } from "@/lib/office/api";
import { formatDateTime, formatZar } from "@/lib/office/format";
import type { GateRecordRow, GovernanceRecord } from "@/lib/office/types";

export const Route = createFileRoute("/office/governance")({
  component: GovernancePage,
});

function GovernancePage() {
  const [record, setRecord] = useState<GovernanceRecord | null>(null);
  const [ceilings, setCeilings] = useState<Record<string, number> | null>(null);
  const [ceilingDraft, setCeilingDraft] = useState<Record<string, string>>({});
  const [ceilingSaving, setCeilingSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getCostCeilings()
      .then((next) => {
        if (cancelled) return;
        setCeilings(next);
        setCeilingDraft(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])));
      })
      .catch(() => {});
    getGovernanceRecord({ data: { limit: 100 } })
      .then((next) => {
        if (cancelled) return;
        setRecord(next);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setError("The governance record could not be read from this session.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      setRecord(await getGovernanceRecord({ data: { limit: 100 } }));
      setError(null);
    } catch {
      setError("The governance record could not be read from this session.");
    } finally {
      setLoading(false);
    }
  }

  const overdue = record?.gates.filter((gate) => gate.decidedAt === null).length ?? 0;

  return (
    <div className="enter-up mx-auto max-w-5xl">
      <PageHeader
        kicker="Governance record"
        title="The test, the answer and the signature."
        description="Every ruling that carried consequence: the precedent episodes, the POPIA section 71 gate records, and the execution receipts signed against the audit chain."
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
            onClick={() => void refresh()}
          >
            {loading ? "Reading…" : "Try again"}
          </Button>
        </p>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Figure label="Precedent rulings" value={String(record?.episodes.length ?? 0)} />
        <Figure
          label="Gate records"
          value={String(record?.gates.length ?? 0)}
          note={overdue > 0 ? `${overdue} still undecided` : "all decided"}
          tone={overdue > 0 ? "warn" : undefined}
        />
        <Figure label="Signed receipts" value={String(record?.receipts.length ?? 0)} />
      </div>

      {record?.receiptKey === "placeholder" ? (
        <p className="mb-6 border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
          Receipts are signed with the local placeholder key. They verify structurally, but they are
          not evidence against a third party until the office runs with a deployment secret.
        </p>
      ) : null}

      <Card className="mb-6 p-4">
        <h3 className="font-serif text-lg">Model cost ceilings (founder-controlled)</h3>
        <p className="mt-1 text-xs text-muted">
          The office reads these at admission time and cannot change them. Empty values keep the
          documented defaults.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          {["capsule", "fire", "daily", "monthly"].map((level) => (
            <label key={level} className="flex flex-col gap-1 text-xs">
              <span className="uppercase tracking-wide text-muted">{level}</span>
              <input
                type="number"
                min={0}
                value={ceilingDraft[level] ?? ""}
                onChange={(e) => setCeilingDraft((d) => ({ ...d, [level]: e.target.value }))}
                className="rounded border border-border bg-surface px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          className="mt-3"
          disabled={ceilingSaving}
          onClick={async () => {
            setCeilingSaving(true);
            try {
              const payload: Record<string, number> = {};
              for (const level of ["capsule", "fire", "daily", "monthly"]) {
                const v = Number(ceilingDraft[level]);
                if (Number.isFinite(v) && v >= 0) payload[level] = v;
              }
              const next = await saveCostCeilings({ data: payload as never });
              setCeilings(next);
              setCeilingDraft(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, String(v)])));
            } finally {
              setCeilingSaving(false);
            }
          }}
        >
          {ceilingSaving ? "Saving…" : "Save ceilings"}
        </Button>
        {ceilings ? (
          <p className="mt-2 text-xs text-muted">
            Active: capsule {ceilings.capsule}, fire {ceilings.fire}, daily {ceilings.daily}, monthly{" "}
            {ceilings.monthly} cents.
          </p>
        ) : null}
      </Card>

      {loading && !record ? (
        <Card className="p-4">
          <p className="text-sm text-muted">Reading the record…</p>
        </Card>
      ) : (
        <Tabs defaultValue="episodes">
          <TabsList>
            <TabsTrigger value="episodes">Rulings</TabsTrigger>
            <TabsTrigger value="gates">Section 71 gates</TabsTrigger>
            <TabsTrigger value="receipts">Signed receipts</TabsTrigger>
          </TabsList>

          <TabsContent value="episodes">
            {!record || record.episodes.length === 0 ? (
              <EmptyState
                title="No precedent yet"
                body="A ruling is written here after the founder approves or rejects an action that carries consequence."
              />
            ) : (
              <ol className="space-y-3">
                {record.episodes.map((episode) => (
                  <li
                    key={episode.id}
                    className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {episode.actionKind.replaceAll("_", " ")}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {episode.companyName ?? "No company"} ·{" "}
                          {formatDateTime(episode.decidedAt)}
                        </p>
                      </div>
                      <Badge variant={episode.outcome === "approved" ? "ok" : "danger"}>
                        {episode.outcome}
                      </Badge>
                    </div>
                    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                      <Detail label="Amount band" value={episode.amountBand ?? "—"} />
                      <Detail label="Stage" value={episode.stage ?? "—"} />
                      <Detail label="Reason code" value={episode.reasonCode} />
                    </dl>
                    <p className="mt-3 border-l-2 border-border pl-3 text-sm text-muted">
                      {episode.reasoning}
                    </p>
                    {episode.exceptionConditions ? (
                      <p className="mt-2 text-sm">
                        <span className="text-muted">Would change the answer: </span>
                        {episode.exceptionConditions}
                      </p>
                    ) : null}
                    {episode.laterOutcome ? (
                      <p className="mt-2 text-sm">
                        <span className="text-muted">Later outcome: </span>
                        {episode.laterOutcome}
                      </p>
                    ) : null}
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-subtle">
                      {episode.agentId ?? "unknown agent"} · {episode.policyVersion ?? "no policy"}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>

          <TabsContent value="gates">
            {!record || record.gates.length === 0 ? (
              <EmptyState
                title="No gate records"
                body="A section 71 gate is opened before a decision that reaches a person."
              />
            ) : (
              <ol className="space-y-3">
                {record.gates.map((gate) => (
                  <GateCard key={gate.id} gate={gate} />
                ))}
              </ol>
            )}
          </TabsContent>

          <TabsContent value="receipts">
            {!record || record.receipts.length === 0 ? (
              <EmptyState
                title="No receipts"
                body="A signed receipt is written for an execution that carries real consequence."
              />
            ) : (
              <ol className="space-y-3">
                {record.receipts.map((receipt) => (
                  <li
                    key={receipt.id}
                    className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {receipt.actionKind.replaceAll("_", " ")}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {formatDateTime(receipt.signedAt)} ·{" "}
                          {receipt.approvedBy ?? "unattributed"}
                        </p>
                      </div>
                      <Badge variant={receipt.signatureValid ? "ok" : "danger"}>
                        {receipt.signatureValid ? "signature valid" : "signature fails"}
                      </Badge>
                    </div>
                    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                      <Detail label="Amount" value={formatZar(receipt.amountCents)} />
                      <Detail label="Risk tier" value={receipt.riskTier} />
                      <Detail label="Decision" value={receipt.decisionId.slice(0, 16)} />
                    </dl>
                    <p className="mt-3 truncate font-mono text-[10px] text-subtle">
                      chain {receipt.chainHead.slice(0, 24)}…
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function GateCard({ gate }: { gate: GateRecordRow }) {
  return (
    <li className="rounded-xl bg-surface p-4 shadow-[var(--shadow-border)]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Approval {gate.approvalId.slice(0, 16)}</p>
          <p className="mt-1 text-xs text-muted">
            Exposed {formatDateTime(gate.exposureAt)}
            {gate.decidedAt ? ` · decided ${formatDateTime(gate.decidedAt)}` : ""}
          </p>
        </div>
        <Badge variant={gate.decidedAt ? "ok" : "warn"}>
          {gate.decidedAt ? "decided" : "undecided"}
        </Badge>
      </div>
      <p className="mt-2 text-sm">
        {gate.legal ? "This case reaches POPIA section 71." : "This case did not reach section 71."}
      </p>
      <ol className="mt-3 space-y-2">
        {gate.questions.map((answer) => (
          <li key={answer.question} className="flex gap-3 text-sm">
            <span
              className={`mt-0.5 shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] ${
                answer.passed ? "text-ok" : "text-danger"
              }`}
            >
              {answer.passed ? "Passed" : "Failed"}
            </span>
            <div>
              <p className="font-mono text-[11px] text-subtle">{answer.question}</p>
              <p className="text-muted">{answer.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      {gate.reasoning ? (
        <p className="mt-3 border-l-2 border-border pl-3 text-sm text-muted">{gate.reasoning}</p>
      ) : null}
      {gate.evidenceShown ? (
        <p className="mt-2 text-sm">
          <span className="text-muted">Evidence shown: </span>
          {gate.evidenceShown}
        </p>
      ) : null}
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-subtle">
        policy {gate.policyVersion}
      </p>
    </li>
  );
}

function Figure({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "warn";
}) {
  return (
    <Card className="p-4">
      <p className="text-[11px] uppercase tracking-[0.16em] text-muted">{label}</p>
      <p className={`mt-2 font-mono text-2xl ${tone === "warn" ? "text-warn" : "text-fg"}`}>
        {value}
      </p>
      {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mt-1 truncate">{value}</dd>
    </div>
  );
}
