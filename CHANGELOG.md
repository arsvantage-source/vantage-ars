# Changelog

All notable changes to Vantage-ARS.

## 5.1.0 — 2026-10-25

### Added

**Customer self-service portal.** A founder can issue a tokenized, read-only link
for a company; the customer opens `/account/<token>` and sees their own
invoices, receipts, quotes, subscriptions and notices, with no login and no
office access. Links expire and can be revoked; one company's data never
leaks through another's link.

**Inbound email ingestion.** `POST /api/inbound-email` turns a posted email
(from, subject, text) into a real inbound item, so a forwarding service can
feed customer replies straight into reception.

**Payment confirmation webhook.** `POST /api/payments/webhook` accepts a
payment reference and amount, matches the invoice by reference, verifies the
amount to the cent, and books the receipt through the existing ledger path.

**Founder-controlled model cost ceilings.** The four model budget levels now
live in a `cost_ceilings` table that only the founder writes; the office
reads them at admission time and can never raise them. Defaults apply until
the founder sets a value. Editable on `/office/governance`.

**RFC 3161 timestamping for anchors.** Anchors can now carry a timestamp token
from an external authority (`TIMESTAMP_AUTHORITY_URL`), stored verbatim on the
`chain_anchors` row, so the head hash is pinned to a time the office cannot
move.

**Accounting exports.** The ledger page now exports Xero and Sage invoice-import
CSV alongside the journal, so the books drop straight into accounting software.

### Verification

- `npm test`: unit checks plus the real-office verification, exit 0.
- `npm run verify:office`: 231 checks, no mocks and no sample data.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build:ci`.


## 5.0.6 — 2026-10-25

### Added

**Audit-chain anchoring.** The office now writes an append-only `chain_anchors`
row once a day carrying the current audit-chain head hash, and mirrors it to an
optional file under `ANCHOR_DIR`. `verifyAnchorsAgainstChain` proves every
anchored head is still in the chain, so a wholesale rewrite that removes an
anchored head is detected instead of passing silently. The thirty-sixth duty,
`seal_chain_anchor`, owns it. A true external timestamp authority (RFC 3161 or
a transparency log) remains optional and is wired through the same store.

### Verification

- `npm test`: unit checks plus the real-office verification, exit 0.
- `npm run verify:office`: 231 checks, no mocks and no sample data.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build:ci`.


## 5.0.5 — 2026-10-24

### Added

**KEY, the token keeper.** A tenth agent checks the Cloudflare token every twelve hours. If the token is missing, pasted with a prefix, or rejected by Cloudflare, KEY tells the founder. It does not record the value and it cannot create a replacement.

## 5.0.4 — 2026-10-24

### Added

**One notice when the office stops itself.** The scheduler tells the founder on the tick that opens the circuit breaker, and once more when a clean probe clears it. It does not repeat on every later tick.

## 5.0.3 — 2026-10-24

### Added

**A standing way to run the desk.** The "Run the desk" delegation lets the office quote a published rate for a real enquiry, email the customer, and — after they accept — mark it won, invoice, match an exact payment, start a subscription, and deliver. It cannot end a subscription, spend money, or pay the founder. A single action over R5,000 still waits, as do more than 20 actions in a day.

## 5.0.2 — 2026-10-24

### Added

**A public diagram of the office.** `/model` names the nine agents, the path from an enquiry to a confirmed receipt, and the actions that still wait. It does not add a product, a price, or a payout.

## 5.0.1 — 2026-10-24

### Added

**Practice photographs on the home page.** Three photographs sit under the desk facts: a desk telephone, a patch panel, and a server cabinet. They name the three physical practices. They do not add a service, a price, or a promise.

## 5.0.0 — 2026-10-23

### Added

**A single service-line index.** `/services` now lists all seven published lines with their scope, links to the detail pages and a route into the finder and the rate card. The public navigation points at it instead of the home-page anchor, the service breadcrumb names it, and its `ItemList` structured data, sitemap entry, tracked path and site-search entry are all generated from the same catalogue.

**Office-wide search.** The founder can search customers, approvals, tickets, documents, ledger entries, subscriptions, leads, opportunities, inbound items, decisions, notices, audit events and every office page from one dialog. It opens with Ctrl/⌘ K, ranks direct title matches first, and reads only the already-loaded founder snapshot; no public endpoint or customer index is involved.

**Approval ageing and an explicit skip.** Waiting approvals show how many days they have been open, and a seven-day backlog is called out on the approvals page. A skip closes a waiting approval without approving it, rejecting it, executing it or writing a precedent. The audit entry says `approval_skipped`, the approval status is `skipped`, and a section 71 gate for that case stays visibly undecided.

**The governance record explorer.** `/office/governance` reads the three governance records in one place: precedent rulings, section 71 gate records and signed execution receipts. Each receipt signature is checked against the deployment key at read time, and the screen states plainly when the local placeholder key is in use. An undecided gate stays marked undecided even after the approval is skipped.

**Support time that is actually recorded.** `/office/service` can log minutes against an account, with a note and work date, under migration `0016_service_time.sql`. A service report now uses those entries for its remote-hours figure and says the figure is recorded. When there are no entries it falls back to the previous one-hour-per-fault estimate and labels it as an estimate.

**Spreadsheet exports that do not execute formulas.** The ledger journal and the combined audit/decision chain can be exported as CSV. A shared cell writer escapes quotes and line breaks and neutralises leading `=`, `+`, `-` and `@`, so a customer name cannot become a spreadsheet formula. The customer book uses the same writer.

**A rate card PDF.** `/rates` can generate a styled PDF containing the published rate groups, scopes, bases and prices, with the same no-promise footer as the site. It is generated in the browser from the catalogue, not from a stored document.

### Changed

**Governance and service documentation match the new surfaces.** The README, autonomy notes and governance architecture now list `/services`, `/office/governance`, support-time capture and the 231-check real-office verification.

### Verification

- `npm test`: 660 unit checks plus the real-office verification, exit 0.
- `npm run verify:office`: 231 checks, including recorded support time, signature verification, the skip path and an undecided section 71 gate.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build:ci`.

## 4.9.0 — 2026-10-23

### Added

**The customer book.** `/office/customers` assembles every company the office has actually touched — enquiry, lead, opportunity, invoice, receipt and subscription — into one account with a status, open balance, monthly recurring value and plan history. It supports search, status filtering, an expandable record and a spreadsheet-safe CSV export. A company with only a page view is not a customer and does not appear.

**Receivables ageing and next renewals.** The revenue page now groups issued invoices into 0–7, 8–30, 31–60 and over-60-day buckets, and lists the active subscriptions closest to their next billing date. Both are read from the office's own records. The ageing is a measure of the book, not a collection forecast.

**A service finder.** `/find` asks three plain questions — the problem, the impact and the horizon — and recommends a published service, the related field guides and a short checklist. It is keyboard accessible, is indexed by site search, and is in the sitemap and traffic tracking. It recommends; it does not quote, price or promise an outcome.

**Site signals for the founder.** The marketing page shows the last thirty days of real page views, top pages, referral sources, countries, daily bars and the latest events. The record still holds no IP address, no cookie and no inferred identity. The panel reads a bounded event window and does not pretend to be an analytics warehouse.

**Guides beside the service.** Each service page now cross-links the field guides that explain its common faults, so a reader can move from a service to the writing without going back through search.

### Changed

**The public surface agrees with itself.** The home heading names the seven service lines honestly, the footer, search, tracked paths, sitemap and route list all include `/find`, and the README and office documentation carry the current route and verification counts.

### Verification

- `npm test`: 640 unit checks plus the real-office verification, exit 0.
- `npm run verify:office`: 218 checks, no mocks and no sample data.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build:ci`.

## 4.8.0 — 2026-10-22

### Added

**Three more public service lines.** Cloud & email covers Microsoft 365 and Google Workspace administration, mail flow and identity. Security & continuity covers a written baseline review across identity, email authentication, administrator access, endpoint protection and backup readiness. Backup & recovery covers what is protected, what has been tested and what is missing. All three have their own service page, published rates, structured data, sitemap entry, traffic tracking, and search results. None claims to be penetration testing, monitoring, a recovery guarantee or a service level.

**Two more productised services.** The quarterly infrastructure review turns the quarter's faults, open items and spend into a prioritised next-quarter list, and is a standalone recurring plan as well as part of the managed support plan. The fault pattern and incident review names the faults that repeat and the resolution times the record can measure. Both are assembled by the office from its own records; the agent never writes the customer's report.

**Site-wide search.** A search dialog in the public header, opened with the button, `/` or Ctrl/⌘ K, searches the site's own published copy: services, rates, guides, common answers and fixed pages. It never reads an office record, a customer document or an unpublished draft. Results are keyboard navigable and fall back to the service desk when nothing matches.

**Five field guides.** `/guides` publishes plain-language notes on one-way VoIP audio, backing up versus recovering, Wi-Fi drops, firewall changes and preparing for remote support. Each guide carries Article, FAQ and breadcrumb structured data, a related-service link, a stated boundary and no promise about an individual system.

**A second path for founder notices.** `FOUNDER_WEBHOOK_URL` optionally posts the same founder notices to an HTTPS webhook (Slack, Discord or any receiver accepting `text` or `content`). SMTP and the webhook can both run; the notice is marked sent when either succeeds, and a failed webhook does not undo the office action. Only HTTPS URLs without embedded credentials are accepted.

### Changed

**Dependencies refreshed.** PGlite 0.5.11 and the current compatible TanStack Router, Start and router-plugin releases are pinned. TypeScript 7 is deliberately not adopted while `typescript-eslint` still declares support below 6.1.

**The catalogue, docs and site now agree.** The managed-services guide, business scope, README, rates page, sitemap, tracked paths and footer all describe nine productised services and the new public service pages. The home and work pages no longer hard-code a four-line catalogue.

### Verification

- `npm test`: 620 unit checks plus the real-office verification, exit 0.
- `npm run verify:office`: 212 checks, no mocks and no sample data.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build:ci`.

## 4.7.1 — 2026-10-22

### Fixed

**A failed action can no longer leave half its writes behind.** `applyProposedAction` used to catch execution errors inside the audit transaction and record the refusal there, which committed whatever the action had already written. The error now rolls the transaction back and the blocked decision is recorded in a separate transaction, so a refusal is visible without leaving a partial invoice, receipt or subscription on the books.

**A quote's price is no longer read from a mutable opportunity.** `documents.amount_cents` snapshots the figure the customer was quoted, and `documents.accepted_at` records when they accepted. Invoices for won work use the snapshot, and subscriptions bill from acceptance rather than from the day the quote was written.

**Money can only be recorded once per invoice.** A receipt is guarded inside the action transaction and by a unique database index, and the receipt document, invoice status and billing-cycle status are written together with the money movement.

**Won work and accepted quotes are now checked per job.** The governor follows a billing cycle, subscription, invoice or quote document back to the opportunity it belongs to, instead of accepting any won job or accepted quote at the same customer. The delegated billing cap is tested against the accepted quote's snapshot, so a later opportunity edit cannot push an invoice past the limit.

**Recurring billing waits instead of duplicating.** A pending period is retried, a settled period advances the clock, and an invoice awaiting founder approval is not re-filed every tick. If the founder rejects the invoice, the period is closed and the subscription moves on instead of re-opening the same approval forever. A paid period still receives its report and notice.

**A failed service notice is retried, not forgotten.** Delivery failure no longer stamps the cycle as notified; the attempt is recorded and the notice is retried later instead of being re-sent every tick.

**Discovery and dunning stop repeating.** A discovery checklist already on file suppresses further discovery work, and the checklist no longer overwrites the buyer's summary or re-prices the opportunity. Dunning reminders are suppressed for seven days after the last reminder, even though the previous work item is closed.

**Public health and error pages leak less.** `/api/health` returns the public projection to anonymous callers and the full document only to a founder session or the cron secret. Public error pages no longer render a server error message. The site-view beacon no longer holds a request open for a nine-second scheduler tick. Rate limiting prefers platform-set client headers, and the public quote view and answer limits are now shared through the database rather than held only in one process.

**Accessibility and metadata corrections.** The live chat is a labelled dialog with a live log, Escape closes it and focus returns to the trigger. Public forms ignore a second submit while one is in flight. The hreflang alternate points at the current page, not the site root.

### Verification

- `npm test`: unit checks plus the real-office verification, exit 0.
- `npm run verify:office`: 212 checks, including quote snapshots, one-time discovery and a single service notice after a failed delivery.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build:ci`.

## 4.7.0 — 2026-10-21

### Added

**The office chooses its own pace.** A new pure policy in `src/lib/office/autonomy.ts` reads the state the scheduler is about to work on — queued and due items, live P0/P1 tickets, inbound and chat waits, billed periods not yet delivered, and consecutive failures — and picks one of four postures. `idle` is a quiet office, `steady` is ordinary work, `surge` is a customer waiting or a queue building, and `recovery` follows repeated failure. Each posture sets a per-agent cap, a per-tick total and, during a surge, halves the cadence of the duties that answer or deliver to customers. The budgets are bounds on one tick, not a daily target, and they never widen the governor.

**A broken scheduler can recover itself.** Five consecutive failing ticks still open the circuit breaker, but the breaker is no longer a dead end. After a thirty-minute cooldown one clean tick probes the real database, the audit chain and the halt state. If they are healthy it clears the failures, writes `scheduler_recovered` to the audit chain and resumes at the recovery budget; if not, it stays closed. The opportunistic nudge now permits that single probe, so an office with no person watching can come back on its own.

**The audit chain is checked before every tick.** The docs claimed a broken chain stopped work, but the scheduler did not read `chainIntact`. It does now: when the chain fails to verify, no ordinary duty is planned, stale work is not reclaimed and only SEAL runs — and the SEAL duty halts the office.

**The founder can see the pace.** The autonomy panel shows the posture and the tick budget, and warns when the office is in recovery. `schedulerStatus()` and `/api/health` carry the same fields. `migrations/0013_adaptive_autonomy.sql` stores `last_posture` and `last_budget` on `office_state`, so the panel reads what the scheduler actually did.

### Changed

**The scheduler's `TickResult` reports its decision.** `posture`, `budget` and `recovered` are part of the result, not inferred afterwards. The scheduler detail line names the pace, a recovery and a broken chain.

**`writeDutyState()` records posture and budget** alongside the duty clock, and `due()` accepts the cadence the posture chose rather than always reading the base cadence.

### Verification

- `npm test`: 584 unit checks, then the real-office verification, exit 0.
- `npm run verify:office`: 208 checks, including a forced breaker, a clean probe and recovery written to the chain.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run build:ci`.

## 4.6.0 — 2026-10-21

### Added

**The desk can be checked without opening the office.** `/status` is a public readiness page built from five real checks: the office database, the decision record, scheduled work, agreement between the public rate card and the office prices, and founder control. The full health document is reduced on the server by `src/lib/office/public-status.ts`, so a visitor never receives treasury figures, customer counts, the halt reason, mail configuration or delegation limits. The page says plainly that it keeps no uptime history, makes no monitoring promise and sells no service level. It is linked from the footer and listed in the sitemap.

**The public pages describe themselves better to machines.** Service pages now emit a `BreadcrumbList` and an `OfferCatalog` narrowed to the rate lines they actually show. `/rates` emits the whole offered catalogue. The service JSON-LD still names the provider and the audience; the new blocks add the hierarchy and the published prices without inventing either.

**`security.txt`.** `/.well-known/security.txt` publishes one contact address, an expiry and the canonical URL, so a researcher does not have to guess where to report a problem.

### Changed

**One source for a published price.** `rateAmountLabel()` and `rateAmount()` live with the catalogue and are now used by the home page, the rates page, the terms page and the service copy. Editing a rate line can no longer leave prose quoting yesterday's figure. `ratePriceValue()` supplies the machine-readable figure to structured data.

**One source for the version.** The office health document had been reporting `4.2.0` while the package was `4.5.0`. It now reports `COMPANY.version`, and a route test fails if that drifts from `package.json`.

**README.DEV is current again.** It no longer describes a long-merged password branch; it documents the local loop, the module boundaries, the test strategy and the route checklist.

**Docs corrections.** Removed a duplicated sentence in the managed-services guide.

### Fixed

**A green test suite could exit as a segmentation fault.** The Node test runner fanned out across every core, importing PGlite and other native/WASM modules in parallel; all 536 tests passed and the process then died with exit 139, so CI never reached `verify:office`. The test command now caps concurrency at four and skips the eager PGlite bootstrap for unit tests — anything that calls `getSql()` still initialises normally. The suite exits 0, and `verify:office` runs.

**The managed-support page was invisible to the site's own signal.** `/services/managed-support` was a published, linked page but was missing from `TRACKED_PATHS`, so its real traffic never became a page view. It is tracked now, and the status page is too. A new test keeps `TRACKED_PATHS` and `sitemap.xml` in step.

### Verification

- `npm test`: 564 unit checks, then the real-office verification, exit 0.
- `npm run check`: typecheck, lint and the full test run.
- `npm run build:ci`: production build with the new route regenerated.

## 4.5.0 — 2026-10-20

### Added

**The office can prove what kind of decision it took.** `migrations/0012_governance.sql` adds three tables that turn a decision into a record a founder, an auditor or a regulator can read years later. The audit chain said that a decision was taken; these say what kind of decision it was, on what terms, and who signed for it.

- `decision_episodes` is the governed precedent memory: one row per Tier 1–3 human ruling, carrying the material conditions the ruling was made under — the action kind, the company, the amount and its band, the opportunity stage, the policy version in force — together with the outcome, a reason code from a closed taxonomy, the founder's own words, and the exception conditions the ruling carried. `later_outcome` is left null on purpose: it is written by a later pass that knows what actually happened, and nothing else may write it.
- `gate_records` is the POPIA section 71 record: the five questions and their answers kept verbatim when the gate is opened, and again when the human decision on it is recorded. The test is kept, not just its result, so the reasoning can be re-read without re-running it.
- `decision_receipts` is a signed receipt for every Tier 1–3 execution, carrying the decision, the authority that allowed it (the approval id, or the delegation id), the chain head it was signed against, and an HMAC over its own payload, so a receipt that has been edited no longer verifies. The signing key is `BETTER_AUTH_SECRET`, falling back to `CRON_SECRET`; with neither set the office signs with a local placeholder key, and the code says so above it, because a receipt signed with a key that is in the repository is not evidence of anything.
- The `approvals` table gains the columns the section 71 record needs: the founder's pre-exposure reasoning, the reason code, the evidence that was shown, the policy version in force, and the moments the case was exposed and decided.

**The founder sees the whole record before they rule.** `/office/approvals` shows the risk tier, the five-question gate, the precedent matches with their effect, the reason codes and the reasoning box. A legal gate cannot be answered until the founder has written down why the case may be exposed at all.

**The risk tier, the section 71 gate and the precedent memory are on the decision path.** `risk.ts` is computed for every action that reaches the store and is written onto the decision row and into the signed receipt. `gate71.ts` produces the gate record and the reason-code taxonomy. `precedent.ts` ranks the earlier rulings and says, in words, that a precedent is evidence and never authority. `cost.ts` runs the admission check before every model call: the counters are read from the `ai_budget` table, the projection is costed, and a call that does not fit is refused with the arithmetic in the refusal.

**The founder can redrive dead work from the office.** The autonomy panel on `/office` now lists the dead-letter queue on its own, with the error that killed each item and a **Redrive** button on each one. `src/lib/office/redrive.server.ts` is where the redrive and the record of the redrive meet, so the item goes back on the queue and the chain carries the `work_redriven` event, or neither happens. The button is behind the founder gate, and no tick can redrive anything.

### Fixed

**The work queue's delays were seconds, not minutes.** The interval arithmetic read `now() + (${minutes} || '0')::interval`, and the `||` was SQL, not JavaScript: the number was concatenated with a zero and Postgres read the result as a bare interval, which is seconds. A 30-minute delay became 5 minutes, a 2-minute retry backoff became 20 seconds, a claimed item left by a dead process was reclaimed after 5 minutes instead of 30, and finished work was pruned after 5 minutes instead of 30 days. Every delay is now built with `make_interval`, and the policy itself lives in `src/lib/office/queue-timing.ts` where it is unit-tested.

**A work item could never be abandoned.** `failWork` stamped `finished_at` with a SQL fragment that this codebase's `sql` surface does not support — the fragment was called as a query and its result was passed as a parameter — so the whole statement failed, the error was never recorded, and the dead-letter queue could not be reached at all. The office's error handling, the thing that keeps a broken duty from being retried forever, was the thing that broke. The stamp is now a `case when`, and the verification drives a duty into the dead-letter queue on purpose.

**Two tests were asserting the wrong thing.** The busy-office fixture did not carry the published rate line of the accepted recurring quote, so the duty that starts a subscription planned nothing and the planner-and-runner self-check failed; and the service-level review test still expected the words "a recorded response", which the report no longer says, because the office records no first response and must not claim one.

### Known limitations, closed

- The autonomy panel has a redrive button. The server function is still founder-only and audited, and the founder can still act without a delegation.
- `precedent.ts`, `risk.ts`, `gate71.ts` and `cost.ts` are called from the action path.
- `scripts/verify-office.mjs` exercises the delegation, the subscription, the billing, the customer notice and the redrive: 198 checks, no mocks, no fixtures.
- `delegations`, `delegation_usage`, `subscriptions`, `billing_cycles`, `customer_notices`, `decision_episodes`, `gate_records` and `decision_receipts` are all in `BACKUP_TABLES`, so a backup carries the delegation, the recurring-revenue book, the customer notices and the governance record.

## 4.4.0 — 2026-10-20

### Added

**The constitution gained an article, and the office gained a way to earn.** `ART-13` (Delegated Authority) lets the founder grant the office a standing, bounded, revocable authority over a fixed class of actions. It is a policy change, not a convenience: `saveDelegation` writes the row and appends a `delegation_saved` event to the audit chain naming the action kinds, the per-action cap, the daily and monthly caps, the rate lines and the three switches. The caps are counted from real rows in `delegation_usage`, written in the same transaction as the action, so a retried tick cannot slip past them. Revocation takes effect on the very next action, because the delegation is read inside the transaction that takes the action.

- The delegatable action kinds are a closed list of nine: `open_opportunity`, `issue_quote`, `propose_close_won`, `issue_invoice`, `record_inbound_payment`, `start_subscription`, `cancel_subscription`, `fulfil_service`, `send_customer_mail`.
- `src/lib/office/delegation.ts` evaluates one action against one delegation and refuses in a fixed order: no delegation, revoked, paused, action not covered, over the amount cap, daily cap reached, monthly cap reached, rate not published, rate not delegated, no accepted quote, no won work, no real enquiry, mail not delegated.
- A delegation never overrides a hard block. It cannot widen an agent's role, permit a price that is not published, permit a promise to a customer, or survive a halt, and a founder's own action never consumes the office's delegation.
- `fulfil_service`, `start_subscription`, `cancel_subscription` and `send_customer_mail` exist only under a delegation. Without one they are refused, not escalated.
- Four presets are offered at `/office/delegations`: Observe only, Deliver and tell the customer, Bill and collect, Managed revenue. None of them is on until the founder saves it, and the office ships with no delegation at all.

**The office can deliver and bill seven productised services.** `src/lib/office/plans.ts` defines seven fixed-scope, fixed-price services whose deliverables the office assembles from its own records: managed support plan (R2,750 / month), remote health and spend watch (R990 / month), service report (R690), billing and rate compliance audit (R1,150), infrastructure documentation and handover pack (R1,380), business continuity plan (R1,725) and service level and response review (R690). Two of them bill on a schedule, which makes them recurring revenue rather than jobs.

- `subscriptions` is the book: a plan, a price, a cycle and the next billing instant. `billing_cycles` is one row per billing period, with a unique index on `(subscription_id, period_start)`, so a retried tick, a restarted server or two concurrent ticks cannot bill the same month twice.
- The revenue engine is `/office/revenue`: the book, the cycles, MRR and ARR, what was billed and collected this month, what is outstanding and overdue, churn risk and the plan mix. A quarterly plan contributes a third of its price to the monthly figure.
- A plan is only sellable if its published rate exists, is offered, and still carries the price the plan quotes. `planIntegrity()` says so instead of quoting a figure the public site no longer shows.
- The office starts a subscription when a customer accepts a quote for a recurring plan, and the first period is the quote they accepted, so nobody is billed twice for the same month. A subscription is one of the actions that exist only under a delegation, so this runs unattended only inside one.
- A customer email is rendered from a template written in code, out of real records, and the body is checked for promise language — guarantees, uptime, response windows, service levels — before it is allowed out. The agent names the template; it never supplies the words.
- The recipient is resolved from the records already on file. The office will not email an address it does not already hold for that customer.

**Every customer email is on the record.** The `customer_notices` table stores the whole message — template, recipient, subject, body, status and delivery time — so the office can always answer "what did you actually send them?". A customer notice is as auditable as a ledger entry.

**Seven new duties**, each on its own cadence: `ledger_subscription_billing` (60m) bills the subscriptions that are due, `ledger_dunning` (240m) reminds a customer about an invoice that has been open between one week and nine weeks, `desk_service_fulfilment` (60m) produces the deliverable for a billing period, `desk_service_notice` (60m) sends the customer their report and invoice, `close_quote_notice` (120m) sends a customer the quote they are waiting on, `ledger_start_subscription` (240m) starts the subscription a customer bought, and `keep_subscription_review` (10080m) reviews the recurring book and checks the published rate card against the plans the office sells. The dunning and quote-notice duties plan nothing at all unless there is an active delegation that allows customer email.

**The ART-13 check is in the trace.** The governor evaluates the delegation after the absolute blocks, so a delegation cannot rescue an action that was already refused for role, dignity, instruction-override or discrimination reasons, and every action whose kind is delegatable carries an `ART-13` line in its constitutional trace with the check that decided it. A decision taken under a delegation records the delegation id on the row and in the chain hash.

**Redrive is a founder action.** `redriveWorkById` puts an abandoned or failed work item back on the queue with its attempt count reset and its error cleared. The only caller is `redriveWork`, behind the founder middleware, which appends a `work_redriven` event to the audit chain. Nothing in the scheduler redrives anything, and the work item comes back due now rather than after a delay.

### Changed

**The public site sells the managed services.** `/services/managed-support` is a service page in its own right, `/rates` has a "Managed services" group carrying the seven plans and their published prices, the home page has a managed-services section, and the sitemap lists the new page. The rates page no longer says that managed support is not offered.

### Known limitations

- The office still cannot deliver a plan, bill a customer or email anyone without a delegation, and the autonomy panel has no button to redrive an abandoned work item. The server function exists, is founder-only and is audited.
- `src/lib/office/precedent.ts` (past rulings as evidence, never authority), `src/lib/office/risk.ts` (risk tiers), `src/lib/office/gate71.ts` (POPIA section 71) and `src/lib/office/cost.ts` (per-capsule cost ceilings) are written and unit-tested but are not yet called from the action path.
- `scripts/verify-office.mjs` does not yet exercise the delegation or the subscription path.
- `delegations`, `delegation_usage`, `subscriptions`, `billing_cycles` and `customer_notices` are not in `BACKUP_TABLES`, so a backup does not carry the delegation, the recurring-revenue book or the customer notices.

## 4.3.0 — Unreleased

### Added

**The office nudges itself when free hosting throttles the timer.** GitHub's cron for a low-traffic repository is best-effort — gaps of hours were observed in production — and Vercel's daily cron is only a floor. So `GET /api/health`, the real page-view beacon and the founder opening the floor now start a catch-up tick whenever the last one is more than ten minutes old: the surfaces that already prove the office is alive are also what keep it alive. The nudge is gated on `AUTONOMY=on`, respects the circuit breaker, runs the exact tick the timer runs with every guard in place, and waits only briefly — the surface answers regardless, and the next hit retries.

**The founder gets a daily briefing.** `vantage_briefing` compiles one honest summary a day — books, approvals waiting, pipeline, the last day's runs, the queue — and records it as a founder notice. Every figure is read from a record at the moment it is written; nothing is estimated. On an empty office it says nothing, because there is nothing truthful to say.

**Marketing now generates demand instead of waiting for it.** Two new SIGNAL duties turn the site's own traffic into pipeline, and every step stops at the founder:

- `signal_prospect` (daily): repeat, anonymous visits to a buying page (`/rates`, `/quote`, a service page) are flagged as a `Prospect ·` lead. No contact is invented, no customer is created, and nothing reaches the founder until qualification scores it as real demand.
- `signal_draft_campaign` (weekly): one owned-channel campaign draft per week for nurtured or qualified leads not yet in sales. Drafting runs autonomously at R0; activation and any spend are a founder approval.

**Queue hygiene.** The scheduler prunes finished work items each tick so the work table stays a queue, and reports pruning in its detail.

### Fixed

**A busy office can no longer misread its own audit chain.** The office view read the chain rows and the stored head in two separate statements, so a tick committing an append between the two reads made verification fail spuriously — a false "the chain does not verify" that would have halted the office through SEAL and tripped every health monitor. Found in production once ticks and health polls started overlapping. The chain and its head are now read in one statement, one snapshot, so the view can never see half of its own write.

**Qualification no longer churns, and never erases what the buyer wrote.** `signal_qualify_leads` is due every three hours, and it used to re-score every lead every time — re-deciding the same lead forever — while `update_lead` overwrote the lead's summary, which is the buyer's own words, with the office's scoring note. Qualification is now a one-time transition out of `engaged`, and the evidence text is preserved so downstream duties score the customer, not themselves.

**Planner and runner registry can no longer drift apart.** `signal_prospect` planned work under a kind no runner was registered for, so every prospect item was closed by the queue without becoming a lead. New regression test `duty-runners.test.ts` plans every duty against a busy office and proves each kind it can produce is one a registered runner executes; the scheduler also reports unregistered kinds loudly in its tick detail instead of counting them as done.

## 4.2.0 — 2026-10-18

### Added

**Autonomy.** The office now runs itself. A durable `work_items` queue and a
scheduler give every agent named duties on their own cadence, replacing the
single manual "Run the floor" button.

- 23 duties across all 9 identities. Every agent has at least one; none may act
  outside its owner's role. Full table: `docs/autonomy.md`.
- `src/lib/office/duties.ts` — pure planning. Each duty is a function of real
  office state returning work, or nothing. An empty answer is a successful run.
- `src/lib/office/duty-runners.server.ts` — execution, through the same governor
  as any manual dispatch.
- `src/lib/office/scheduler.server.ts` — the tick. Refuses to run while halted,
  with the database down, with the chain broken, or after five failing ticks.
- `src/lib/office/work-queue.server.ts` — deduped by a partial unique index,
  claimed atomically, bounded retries with backoff.
- `AutonomyPanel` on `/office`: scheduler state, every duty and when it is next
  due, the live queue, and what each agent did last.
- `AUTONOMY=on` + `CRON_SECRET` enable unattended runs. The ten-minute tick is
  scheduled by the `office-scheduler` GitHub Actions workflow (Vercel's Hobby
  plan rejects crons more often than daily); `vercel.json` keeps a daily
  `/api/cron/floor` run as a fallback.

**Sales.** `close_quote_followup` drafts a real follow-up once a genuine quote
has waited two days, and says in the letter whether the customer actually opened
the link. `close_stale_proposal` reports proposals with no movement for fourteen
days. `close_win_handoff` flags a won deal with delivery open and no invoice.
`close_discovery` writes a real discovery checklist against a live opportunity.

**Marketing.** `signal_qualify_leads` scores every lead on what the buyer
actually wrote — demand, support, detail, urgency, organisation — and discards
unsolicited outreach outright. `signal_handoff` files a founder-gated sales
handoff only for genuine buying intent. `signal_site_signals` and
`signal_content_brief` work from real recorded page views.

**Real site signals.** `/api/site-signal` records real page views: path,
referrer, country, client hints. Nothing is synthesised and nothing about the
visitor is identified — a POPIA position, not a preference.

**Health.** `GET /api/health` answers "is the business running?" — database and
schema, audit chain, scheduler freshness, queue, mail delivery, money position.
503 when something that matters is wrong. Signs in for the full picture.

**Verification.** `npm run verify:office` boots a real office on a real embedded
Postgres, files the records the public site would really file, runs the real
scheduler, and asserts on what the real agents did. 70 checks, no mocks, no
sample data. It runs in CI.

### Fixed

**The autonomy chain could not write on real Postgres.** `advisoryKey` masked
its FNV-1a hash over the full unsigned 64-bit range, but Postgres advisory
locks take a signed bigint. The chain lock (`vantage-ars:audit-chain`) hashed
to 16358042832438545941 — past 2^63 — so every production chain write failed
with "value is out of range for type bigint" and the scheduler circuit-broke on
its first true tick. PGLite stubs `advisory()` as a pass-through, which is why
tests never caught it. The key is now interpreted as signed 64-bit, with a
regression test pinning the exact case.

**Money could be created from nothing.** `record_inbound_payment` credited
treasury unconditionally and then floored the receivable at zero, so a duplicate
receipt created cash. It now applies only against the outstanding receivable,
under lock, in the same transaction as the ledger row.

**Duplicate invoices and receipts.** The guards read the windowed snapshot
(80 ledger rows, 40 documents) rather than the tables. Past that window they
silently stopped protecting the books. They now query the whole table.

**Double execution on a double-click.** Approval resolution read the row, then
updated it non-conditionally, so two clicks both executed. It now claims the row
with `where status = 'pending' returning id` inside the transaction, and honours
a halt.

**The audit chain could fork.** Decisions and audit events each did their own
read-modify-write of the shared head, with no lock. Both now run in one
transaction under a named advisory lock, reading the head `for update`. The
chain covers the observation and evidence hash too.

**Chain verification walked the wrong way.** The walker treated the newest record
as the start, so a healthy office reported as broken and SEAL halted it. Fixed,
with 10 tests covering forks, gaps, moved heads and hash collisions.

**DML ran on the read path.** `readSnapshot` executed `CREATE TABLE`, three
`ALTER TABLE ... ADD COLUMN` and an unconditional `UPDATE` on every page load —
an ACCESS EXCLUSIVE lock convoy on a pooled Postgres, and a silent overwrite of
any payment note the founder had typed. All moved to migrations and to a one-time
provision step.

**Duty side effects ran before the decision was recorded**, so a throw mid-way
left a ledger entry with no decision and no audit row. Everything is now one
transaction.

**Quotes were grounded in the wrong thing.** The governor checked the amount
against the rate card but let the customer-facing _text_ come from agent prose.
The document body is now generated from `QUOTE_SPECS`; extra scope lines are
accepted only if they contain no promise language, no discount and no figure
other than the published one.

**Chat locked itself out.** A 4-second poll is 900 requests/hour against a
120/hour limit, so both chat desks throttled themselves after eight minutes.
Polling now pauses on hidden tabs, backs off when idle, and the founder's desk
uses an authenticated read with its own budget.

**Password reset was unreachable.** `/forgot-password` and `/reset-password`
existed but were missing from the committed route tree, so both the link on the
sign-in door and the link inside the reset email were dead. The tree is
regenerated and CI catches drift.

**Reload loop.** With `VITE_AUTH_ENABLED=false` the sign-in door redirected to
`/office`, which was locked, which rendered the door again. The door now explains
the state and offers the one action that fixes it.

**Halt button and treasury display.** The halt button called `haltOffice()` with
no arguments and always failed; the treasury read a field that does not exist and
always showed R0.00. Both fixed, and halt state is read from the server instead
of local state.

**Opaque references.** A document reference was 8 hex characters — 32 bits, with
birthday collisions around 77k documents. Now 50 bits in an alphabet that
survives being read over the phone.

**Leads carried the agent's words.** Reception filed leads with its own one-line
summary, so marketing scored an agent's optimism rather than what the buyer wrote.
Leads now carry the customer's own text.

**Idle agents were reported as broken.** Liveness flagged any agent without a
recent heartbeat, so a quiet office produced nine alerts a day. It now reports an
agent only when it has work waiting, or has genuinely never run.

**Federated buttons rendered when OAuth was off.** The sign-in door showed Google
and X regardless of `GROK_OAUTH`, offering buttons that could only fail.

**Reset forms.** Mojibake in user-visible strings, no `noindex`, inconsistent
layout, and a required search param that cost a redirect on every load.

### Changed

- `.env.example` now exists. It was referenced by nine places and did not exist.
- `BACKUP_TABLES` includes `quote_links` and the autonomy tables. A restore used
  to silently kill every open customer quote link.
- Restore is transactional and measures bytes, not UTF-16 code units.
- The pool is configured (size, timeouts, TLS) and the Neon boot path fails
  loudly when the schema is missing instead of producing "relation does not exist"
  deep inside a request.
- Migration `0010` adds the autonomy tables and 22 indexes for the queries the
  office actually runs.
- `ensureOffice` runs once per process instead of on every page load.
- Health metrics are derived from rows. `constraintAdherence` was hardcoded to
  `1`, so a blocked action never showed up in the headline number.
- Accessibility: `aria-current` on navigation, a skip link, a labelled dialog,
  textual (not colour-only) agent status, `th` scope, `role="alert"` on chat and
  enquiry errors.

### Removed

- 16 committed `.wrangler` miniflare SQLite artefacts — machine-local state that
  could contain KV/D1/R2 data. Now git-ignored, with a CI check.
- `src/components/office/format.ts`, a stray duplicate with a broken import that
  blocked `tsc`.

### Known limitations

- The autonomy duties decide from office records, not from a language model. That
  is deliberate: it is why they run without `CLOUDFLARE_API_TOKEN`, and why a
  model outage cannot stop the business.
- The model-driven dispatch panel (`/office` → brief an agent) still needs a
  reasoning provider configured.
- On Vercel, `DATABASE_URL` must point at Postgres. PGLite cannot persist in a
  serverless filesystem.
