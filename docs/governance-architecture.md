# Governance architecture

This is how the office is bounded, how it proves what it did, and what it does
not do. `docs/autonomy.md` lists every duty; this document is about the
machinery that decides whether a duty is allowed to do anything at all.

Nothing here is aspirational. Every claim below points at a file in this
repository, and where the code does something less than the prose claims, the
prose says so.

## The five planes

The office is five planes that never overlap. Work starts in the first, is
judged by the second, is written by the third only when a person asks for it,
is recorded by the fourth, and stops at the fifth whenever the constitution
says a person must decide.

### 1. Orchestration control plane

The scheduler decides _what_ should happen. It does not decide whether it is
allowed to.

- `src/lib/office/scheduler.server.ts` — the tick. It refuses to run blind:
  a halted office, an unreachable database, a broken audit chain, or five
  consecutive failing ticks all stop it before anything is planned. Then it
  plans, then it executes.
- `src/lib/office/duties.ts` — the duty cadence table (`DUTY_CADENCE_MINUTES`,
  35 duties), the owner table (`DUTY_OWNER`) and the title table
  (`DUTY_TITLES`). `planDuty` is a pure function of the real office state and
  returns work or nothing. An empty answer is a successful run.
- `src/lib/office/office-view.server.ts` — `readDutyView` assembles the state a
  duty is allowed to see. A duty cannot read a table it was not given.
- `src/lib/office/work-queue.server.ts` — the durable queue. `enqueueWork` is
  deduplicated by the database, `claimWork` takes the most urgent due item
  atomically (`for update skip locked`), `failWork` applies a bounded backoff,
  `releaseStaleWork` reclaims work abandoned by a process that died, and
  `pruneWork` keeps the table a queue rather than a log.
- `src/lib/office/duty-runners.server.ts` — the runner registry. A work kind
  with no registered runner is reported in the tick detail instead of being
  closed as if it had been done.

### 2. Execution firewall and policy gate

`src/lib/office/governor.ts` — `authorizeAction` — is the only way an agent's
action reaches the world. A founder approval does not pass through it: the
founder is the authority, and `resolveApproval` executes the approved action
directly, inside the transaction that claims the approval. The governor returns
`allow`, `review` or `deny`, and every check it runs is written into the trace
with the article it came from.

The order is the point. The absolute refusals come first, so a delegation
cannot rescue an action that was already refused:

| Order | Check                      | Article       | Effect                                            |
| ----- | -------------------------- | ------------- | ------------------------------------------------- |
| 1     | Known identity             | ART-10        | deny                                              |
| 2     | Halt                       | ART-10        | deny                                              |
| 3     | Role separation            | ART-11        | deny                                              |
| 4     | Instruction override       | ART-10        | deny                                              |
| 5     | Human dignity              | ART-7         | deny                                              |
| 6     | Non-discrimination         | ART-3         | deny                                              |
| 7     | Sales boundary             | ART-11        | trace (the deny comes from role separation)       |
| 8     | Delegated authority        | ART-13        | deny when the kind exists only under a delegation |
| 9     | Handoff gate               | ART-12        | deny                                              |
| 10    | Published price            | ART-4         | deny                                              |
| 11    | Invoice gate               | ART-12        | review                                            |
| 12    | Cost gate                  | ART-2, ART-12 | review                                            |
| 13    | Marketing-to-sales handoff | ART-12        | review                                            |
| 14    | Customer win               | ART-12        | review                                            |
| 15    | Customer loss              | ART-12        | review                                            |
| 16    | Confidence floor           | ART-9         | review below 0.50                                 |

A deny is never downgraded: every later check that would escalate rather than
refuse tests `if (verdict !== "deny")` first. The trace keeps every check, so
the refusal stays readable even though the headline reason is the last one
written.

Three gates carry the weight.

- **Confidence floors.** Below 0.50 the action is escalated to the founder
  (ART-9 critical). Between 0.50 and 0.70 it passes with a
  `log_and_continue` runtime constraint. At 0.70 and above it passes. The
  thresholds are the constitution's own parameters
  (`confidence_warning: 0.7`, `confidence_critical: 0.5`).
- **The published-price check.** A quote is priced again by `priceQuote` at
  the moment of the decision, and the amount the agent proposed must equal the
  published figure to the cent. A quote that does not reconcile is denied.
- **The founder gates.** Cost, customer win, customer loss and every
  marketing-to-sales handoff. A delegation is the only thing that can satisfy
  one of these in advance.

`src/lib/office/constitution.ts` holds the thirteen articles. They are data:
the governor reads them to name the article on every trace line, and the
constitution page in the office renders the same list.

### 3. The bounded LLM capsule

`src/lib/office/ai.server.ts` — `proposeActions` — is the only place a language
model is used, and it is deliberately small.

- **One call.** A single request at temperature 0.2, 1 400 tokens maximum,
  with one bounded retry on a timeout, a rate limit or a 5xx.
- **A fixed prompt.** The system prompt is a constant. The constitution is
  rendered into the user message; the model's own output is never treated as
  instruction.
- **No coordination authority.** The model cannot choose which duty runs, when
  it runs, or which agent runs it. `normaliseAction` replaces any action kind
  the assigned agent does not hold with `notify_operator`, and the governor
  re-decides the action afterwards.
- **No memory.** There is no conversation history, no agent state, and nothing
  carried between calls. Every call gets the state the caller passed in.
- **Not in the autonomous path at all.** The 35 duties decide from office
  records. That is why the office keeps working when the model provider is
  down, and it is why `XAI_API_KEY` or `CLOUDFLARE_API_TOKEN` are optional.

### 4. The immutable audit and provenance store

One chain, two tables. `audit_events` and `decisions` are hash-chained
together, and the head lives in `company_state.last_audit_hash`.

- **The chain.** `chainHash(previous, record)` in `src/lib/office/hash.ts`
  covers the action, the status, the trace, the observation, the evidence hash
  and the delegation id. A tampered row cannot be re-hashed into something
  valid, because the evidence hash is inside the hash.
- **The lock.** Every chain write goes through `withChain`
  (`src/lib/office/store.server.ts`), which takes the Postgres advisory lock
  `vantage-ars:audit-chain` and reads the head `for update`. Decisions and
  audit events share the lock, so the chain cannot fork.
- **SEAL's verification.** `src/lib/office/integrity.ts` — `verifyChainLinks`
  walks backward from the head and distinguishes a fork, a gap, a moved head
  and a hash collision. The `seal_chain_verify` duty runs every twelve hours;
  a failure plans `halt_broken_chain` with `maxAttempts: 1`, because a broken
  chain must not be retried into a false pass.
- **Backup and restore.** `src/lib/office/backup.ts` exports a fixed list of
  tables with a SHA-256 checksum over the stable JSON. `exportBackupJson` and
  `restoreBackupJson` (`src/lib/office/store.server.ts`) restore add-only, in
  one transaction under the chain lock, with a `backup_restored` audit event.
  A half-restored office is impossible.

### 5. The human-in-the-loop gateway

- **Escalation.** `applyProposedAction` writes the action into `approvals`
  with its constitutional trace, writes an `escalated` row into `decisions`,
  appends an `approval_opened` event to the chain, and mails the founder.
- **Resolution.** `resolveApproval` claims the row with
  `update approvals … where status = 'pending' returning id` inside the
  transaction that performs the work. A rejection is recorded as a `blocked`
  decision so the refusal does not stay open forever in the metrics. An
  approval while the office is halted is refused.
- **The gate itself.** `src/lib/office/founder-gate.ts` — `founderMiddleware`
  rejects every office action that is not the signed-in founder, checked
  against `FOUNDER_EMAIL`. The founder is the only account that can exist.
- **The delegation.** ART-13, described below: the founder answering a whole
  class of question in advance instead of one action at a time.

## Risk tiers

There are two things in this repository that are called tiers, and they are
not the same thing.

**The governor's tiers are hard block and escalation.** Every check produces
one of them. A hard block stops the action. An escalation hands it to the
founder. There is no third state, and no number: the tiers are a code
decision, and the code is reviewed and unit-tested like any other code.

**The risk module names the tiers a founder would argue with.**
`src/lib/office/risk.ts` — `assessRisk` returns one of six labels, in order of
consequence:

| Tier | Name            | What it means                                                                       |
| ---- | --------------- | ----------------------------------------------------------------------------------- |
| 1    | `1-Legal`       | The output decides something about a natural person, so POPIA section 71 may apply. |
| 1    | `1-Financial`   | Money leaves the company, or a large sum is committed.                              |
| 2    | `2-Destructive` | The action cannot be undone cleanly.                                                |
| 3    | `3-Value`       | Real value is created or committed.                                                 |
| 4    | `4-Ambiguous`   | Judgement is needed, but nothing outside the office moves.                          |
| 5    | `5-Routine`     | Ordinary work: no money, no customer, no commitment.                                |

Tiers 1 to 3 are gated; 4 and 5 the office may do alone. The high-value line
is R25 000.00 (`HIGH_VALUE_CENTS`). The module is deterministic, has no clock
and no database, and is unit-tested in `src/lib/office/risk.test.ts`.

Being honest about where it sits: the tier is computed on the decision path,
in `store.server.ts` — `riskOfAction` runs for every action that reaches the
store, and the tier is written onto the decision row and into the signed
receipt. `/office/approvals` shows it next to the case, so the founder can
see what tier of decision they are being asked to make before they make it.
The governor's own hard-block and escalation tiers are still what stops the
action; the risk tier tells the founder what kind of question this is.

**The other two axes.**

- **Confidence.** Floors at 0.70 and 0.50, described above. The confidence
  figure is supplied by the caller — a duty, or the model in the dispatch
  panel — and the governor does the comparing, not the producer.
- **Reversibility.** `reversibilityOf` labels an action `fully_reversible`,
  `costly_reversible` or `partially_reversible` from its kind, and the label
  is stored on the decision row. The constitution's ART-6 is a planning
  heuristic (weight 0.3) and the office does not yet choose between two
  candidate actions on reversibility; it labels the one it was given.
- **The delegation envelope.** `maxAmountCents`, `maxActionsPerDay`,
  `maxActionsPerMonth`, the action kinds, the published rate lines, and three
  switches: customer email, automatic payment matching, and whether an
  accepted quote is required. Described in full below.

**What is deterministic and what an LLM touches.** Everything that decides is
deterministic TypeScript: the governor, the delegation evaluator, the price
check, the caps, the chain, the queue, the money. The model may only propose
an action from a closed list, and only on the founder's instruction; the
governor re-decides it. The autonomous duties use no model at all. The
delegation itself is a founder writing a policy down, and the policy is
evaluated by the same deterministic code that enforces the constitution.

## Proof of absence

The hardest thing for an office that runs unattended is telling the
difference between "there was nothing to do" and "nothing ran". The office
records the difference rather than assuming it.

- **The duty-state table.** `office_state.duty_state_json` holds a timestamp
  per duty, written at the end of every tick. A duty that has never run has no
  entry; a duty that ran has one, whatever it decided. `/office` renders
  every duty and when it is next due.
- **The partial unique index.** `work_items_dedupe_idx` is unique on
  `dedupe_key` where the item is open. A recurring duty cannot stack two open
  items for the same record, and the database refuses the duplicate rather
  than a check-then-insert race deciding it.
- **The agent heartbeat.** `agents.last_heartbeat` is written after every run
  (`recordRun`). The `vantage_liveness` duty reports an agent only when it
  has work waiting and has not recorded work for two hours, or when it has
  never run at all. An agent with an empty queue is idle, which is the
  correct state for most of the day.
- **The circuit breaker.** `office_state.consecutive_failures` counts failing
  ticks. At five the scheduler refuses to act at all until somebody looks.
- **The abandoned-work queue.** `work_items.status = 'abandoned'` is the
  dead-letter state. The `vantage_backlog` duty files
  `report_abandoned_work`, and the tick detail names the count.
- **Reclaimed work.** `releaseStaleWork` returns items left `claimed` by a
  process that died mid-run. If their attempts are exhausted they are
  abandoned rather than reopened, so a crash cannot turn into an infinite
  retry.

An empty duty plan is a successful run, and the tick says so: "No duty found
work to do."

## The dead-letter queue and redrive

`failWork` in `src/lib/office/work-queue.server.ts` holds the retry maths, and
the policy itself lives in `src/lib/office/queue-timing.ts`, where it is
unit-tested:

- The next attempt is due at `now() + min(60, 2 ** attempts)` minutes: two
  minutes after the first failure, four after the second, eight after the
  third. The backoff is capped at an hour. The delay is written with
  `make_interval(mins => …)`, so it is minutes of real time and not a number
  of seconds that looked like minutes.
- `max_attempts` defaults to 3, so an item is attempted three times. A duty
  that must not be retried sets it explicitly: `seal_chain_verify` files its
  halt with `maxAttempts: 1`.
- When `attempts >= max_attempts` the item becomes `abandoned`, the error is
  kept in `last_error` for whoever reads the dead-letter queue, and
  `finished_at` is stamped.

Redrive is a founder action and never an automatic one. `redriveWorkById`
accepts only an item in `abandoned` or `failed`, puts it back to `open` with
`attempts = 0`, clears the error and makes it due now. Its only caller is
`redriveAbandonedWork` in `src/lib/office/redrive.server.ts`, which is
where the redrive and the record of the redrive meet: the item goes back on
the queue and the chain carries a `work_redriven` event naming what was
redriven, or neither happens. `redriveWork` in `src/lib/office/api.ts` calls
it behind `founderMiddleware`. Nothing in the scheduler redrives anything,
and no tick can.

The office interface has the button. The autonomy panel on `/office` lists
the dead-letter queue on its own, with the error that killed each item, and
a **Redrive** button on each one. The button is behind the founder gate, and
the redrive is on the audit chain like everything else the founder does.

## Governed precedent

**The record.** The `approvals` table is the record of past rulings: every
founder gate the office reached, whether it was approved or rejected, with the
constitutional trace, the action itself, the amount and the founder's note.
The `decisions` table records every action the office took or refused, with
its trace, its reversibility, its observation, and the delegation id when the
action was taken under one.
`/office/approvals` shows the pending gates and the resolved ones, so the
founder can read what they have already decided.

**Evidence, never authority.** Nothing in the code reads a past approval to
permit a present action. There is one deliberate exception:
`hasApprovedHandoff` lets Sales open the opportunity for a company whose
marketing-to-sales handoff was approved. It is narrow — a specific company, a
specific next step — it is checked against the whole table rather than a
window, and it grants a step rather than a class of action.

**The ranking logic.** `src/lib/office/precedent.ts` is the module that decides
which earlier rulings are worth showing. It compares the material conditions
only — action kind, company, amount band, stage and policy version — because a
ruling made under different conditions is not a ruling about this case. Amounts
are compared in bands (`under_r500` … `over_r25000`), so a ruling about R240
still speaks to one about R480. A match is `strong_match`, `related` or
`weak`, and its effect is `evidence`, `tighten` (a past refusal that named its
exception conditions) or `escalate_as_novel` (the policy version has moved).
`precedentAdvice` always says the same thing in plain words: earlier rulings
are evidence, not authority, and the decision is made afresh.

Being honest about where it sits: the ranking is called, and it is called
from the approval path. `store.server.ts` reads the `decision_episodes` table,
matches the case against the material conditions, and hands the matches to
`precedentAdvice`; `/office/approvals` shows the matches, the similarity and
the effect next to the case, and says in words that a precedent is evidence
and not authority. Nothing reads a past ruling to permit a present action.

**Graduated trust.** The delegation is the step from one approval at a time to
a standing answer. A founder who keeps approving the same class of action can
write that class into a delegation, and a delegation is a policy change, not a
convenience:

- `saveDelegation` writes the row and appends a `delegation_saved` event to
  the chain, naming the action kinds, the per-action cap, the daily and
  monthly caps, the rate lines and the three switches.
- `revokeDelegation` appends `delegation_revoked`. Revocation takes effect on
  the very next action, because the delegation is read inside the same
  transaction that takes the action.
- The caps are counted from real rows: `delegation_usage` records every
  action taken under a delegation, in the same transaction as the action, so a
  retried tick cannot slip past them.
- A delegation is never consumed by a founder's own action.
  `applyProposedAction` only loads a delegation when the action is
  autonomous.

What a delegation cannot do is fixed in the constitution and enforced in the
evaluator: it cannot widen an agent's role, cannot permit a price that is not
published, cannot permit a promise to a customer, cannot survive a halt, and
cannot sell to a company that never contacted the office.

## The silence rule

An approval the founder never answers is skipped. It is never granted by the
passage of time.

**Where it is enforced.** The only statement in the codebase that sets an
approval to `approved` is inside `resolveApproval`
(`src/lib/office/store.server.ts`), which is called from founder-only server
functions behind `founderMiddleware`. No duty, no runner, no scheduler path
and no migration writes an approval status. The rule therefore holds by
construction: there is no code path from elapsed time to a granted approval.
The governor is the second half of it — an action that needs a person is
escalated, not executed, and the delegation is the only thing that can
satisfy the gate in advance.

**Where it is not yet enforced.** There is no `skipped` state. An unanswered
approval stays `pending` in the table indefinitely: it is not expired, not
withdrawn, and not logged as skipped, and no duty ages it out. The
`vantage_backlog` duty reports a stuck queue and abandoned work, not ageing
approvals. The metrics count them — `selfHealing` drops as the pending pile
grows — but nothing marks one as skipped. So the office records the absence of
an answer as an open item rather than as a decision, and the founder is told
about the pile rather than being told that silence was read as consent.

The rule is stated in the founder's own words on `/office/delegations`: "The
office does not read silence as consent."

## The governance record

The chain says that a decision was taken. Three tables say what kind of
decision it was, on what terms, and who signed for it. They are created by
`migrations/0012_governance.sql`, and they are in the backup manifest, so a
restored office keeps its own governance history.

**`decision_episodes` — the precedent memory.** One row per Tier 1–3 human
ruling. It stores the material conditions the ruling was made under: the
action kind, the company, the amount and its band, the opportunity stage, the
policy version in force, and the outcome. It stores the reason code from a
closed taxonomy (`src/lib/office/gate71.ts` — `REASON_CODES`; a code that is
not in the taxonomy is never invented at runtime), the founder's own words,
and the exception conditions the ruling carried. `later_outcome` is left null
on purpose: it is written by a later pass that knows what actually happened,
and nothing else may write it.

**`gate_records` — the POPIA section 71 record.** One row when a legal gate is
opened, carrying the five questions and their answers verbatim, and another
when the human decision on that gate is recorded. The test is kept, not just
its result, so the reasoning can be re-read years later without re-running
it. The `approvals` table gains the columns the record needs: the founder's
pre-exposure reasoning, the reason code, the evidence that was shown, the
policy version, and the moments the case was exposed and decided.

**`decision_receipts` — the signed receipt.** One receipt per Tier 1–3
execution, carrying the decision, the authority that allowed it (the approval
id, or the delegation id), the chain head it was signed against, and an HMAC
over its own payload. A receipt that has been edited no longer verifies. The
signing key is `BETTER_AUTH_SECRET`, falling back to `CRON_SECRET`; with
neither set the office signs with a local placeholder key, and the code says
so in the comment above it, because a receipt signed with a key that is in
the repository is not evidence of anything.

**What the founder sees.** `/office/approvals` shows the risk tier, the
five-question gate, the precedent matches and their effect, the reason codes
and the reasoning box, so the ruling is made with the record in front of it
rather than from memory. `/office/governance` reads the three tables together:
the rulings, the gates and the receipts, with each signature checked at read
time and the placeholder-key state stated plainly. A skipped approval is closed
without a ruling, so its gate record remains visibly undecided.

The `pre-exposure reasoning` is required before a legal gate can be answered at
all: the case is not exposed until the founder has written down why it may be.

## What is deliberately not implemented

None of the following exists in this repository. Each is a real limit on what
the office can prove, and each entry says what the office does instead and
what closing the gap would take.

- **No hardware-rooted presence attestation.** There is no WebAuthn, TPM or
  key-attestation evidence attached to a decision. Instead: the hash chain,
  the chain lock, and a founder session for anything that changes state. To
  close it: sign the decision hash with a key held in a hardware token or the
  platform keystore, and record the attestation beside the record hash.
- **No biometric liveness.** There is no face, fingerprint or behavioural
  check on the founder. Instead: email and password through Better Auth, and
  the approval itself as the human-in-the-loop record. To close it: run a
  liveness check before an approval is accepted, and put the result in the
  trace.
- **No RATS or Veraison appraising hardware evidence.** There is no
  in-toto-style statement signed by a separate party. Instead: the office
  produces its own evidence — documents, ledger rows, service reports — and
  checks it against itself. To close it: have the appraising party sign a
  statement about the evidence and attach it to the decision.
- **Anchoring.** The chain is internally verifiable and SEAL checks it every
  twelve hours. The office now also writes an append-only `chain_anchors` row
  once a day carrying the head hash, and mirrors it to an optional file under
  `ANCHOR_DIR`. `verifyAnchorsAgainstChain` proves every anchored head is still
  in the chain, so a wholesale rewrite that removes an anchored head is
  detected. A true external timestamp authority (RFC 3161 / a transparency log)
  is still optional: set `ANCHOR_DIR` to a path that is itself replicated or
  append-only for the strongest guarantee.
- **No OPA or Rego policy engine.** The policy is TypeScript:
  `src/lib/office/governor.ts`, `src/lib/office/delegation.ts` and
  `src/lib/office/constitution.ts`. It is reviewed in the same way as every
  other file in the repository, and it is covered by `governor.test.ts` and
  `delegation.test.ts`. That is the same risk the repository already carries
  elsewhere — a code change is a policy change — and the same mitigation: a
  human reads the diff. To close it: compile the articles into a Rego bundle
  loaded at boot, and record the policy version on every decision.
- **No Temporal, or any other workflow engine.** The scheduler is a durable
  queue in Postgres: `work_items`, `office_state` and `billing_cycles`, with
  the partial unique index, the atomic claim and the chain lock doing the work
  an engine would do. To close it: define a workflow per duty with timers and
  retries, and reconcile the engine's state against the office tables on every
  tick.
  Three more pure modules are on the decision path, and the same applies to
  them: `src/lib/office/risk.ts` (risk tiers, computed for every action that
  reaches the store and written onto the decision row and the receipt),
  `src/lib/office/gate71.ts` (the POPIA section 71 five-question test, written
  into `gate_records` and shown on the approval screen) and
  `src/lib/office/telemetry.ts` (the OpenTelemetry GenAI span attributes, written
  for every model call).

**The cost gateway is in place.** `src/lib/office/cost.ts` holds four
ceilings — capsule, fire, day and month — and `ai.server.ts` runs the
admission check _before_ the fetch: the counters are read from the
`ai_budget` table, the projection is costed, and a call that does not fit is
refused with the arithmetic in the refusal. The spend is added to the counters
in one statement with an arithmetic increment, so two instances calling the
model at the same time cannot lose one another's spend. What is missing is
only the outside limit: the ceilings are the office's own, and nothing stops
the office from raising them.

## How to verify

```sh
npm run verify:office
```

It boots the real application modules against a real embedded Postgres, files
the records the public site would really file, runs the real scheduler, and
asserts on what the real agents actually did: 231 checks, no mocks, no
fixtures. It runs in CI on every push.

It exercises the delegation and the subscription path end to end: the office
sells a managed plan on its own under a delegation, the customer accepts on
their own link, the subscription starts itself, the next period is billed
once, the payment is matched, the deliverable is produced from the office's
own records, the customer notice is prepared and recorded, and the revocation
takes effect on the very next action. It also drives a duty into the
dead-letter queue, proves that no tick redrives it, and then has the founder
redrive it by hand and checks the chain.

The unit tests cover what a single run cannot:

```sh
npm test
```

The ones that matter for governance:

- `src/lib/office/governor.test.ts` — role separation, halt, instruction
  override, dignity, non-discrimination, the handoff gate, the invoice gate,
  the cost gate, customer win and loss, the confidence bands, and the
  published-price check.
- `src/lib/office/delegation.test.ts` — the envelope, from both ends: no
  delegation, revoked, paused, an action the delegation does not cover, the
  amount cap, the daily and monthly caps, an unpublished rate, the accepted-
  quote requirement, charging for work that was not won, selling to a company
  that never wrote, mail that was not delegated, and the four presets.
- `src/lib/office/integrity.test.ts` — the chain: a fork, a gap, a moved head
  and a hash collision.
- `src/lib/office/duties.test.ts` — every duty plans from a fixture, and an
  empty plan is a successful run.
- `src/lib/office/duty-runners.test.ts` — every kind a duty can produce is
  one a registered runner executes.
- `src/lib/office/precedent.test.ts`, `src/lib/office/risk.test.ts`,
  `src/lib/office/gate71.test.ts`, `src/lib/office/cost.test.ts`,
  `src/lib/office/plans.test.ts`, `src/lib/office/subscription.test.ts`,
  `src/lib/office/fulfilment.test.ts`, `src/lib/office/queue-timing.test.ts`,
  `src/lib/office/backup.test.ts` and `src/lib/office/work.test.ts` — the
  modules named above.

`npm run validate` runs the typecheck, the lint and the tests together.
