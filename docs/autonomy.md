# The autonomous office

This is how Vantage-ARS runs itself, and — more importantly — what stops it
doing anything it must not.

## The idea

The office is ten agents with fixed roles and no memory. It does not "decide to
be busy". Instead it keeps its own to-do list in Postgres, and a scheduler that
runs every ten minutes asks each agent a single question: **given what is
actually on the books, is there a real thing worth doing?**

An empty answer is a successful run. Most of the time, the honest answer is that
nothing needed doing, and the office says so rather than manufacturing activity.

## The pace

The office does not run every tick at the same width. It reads the state it is
about to work on and chooses a posture: `idle`, `steady`, `surge` or `recovery`.
The posture sets how many items each agent may run, how many the tick may run in
total, and whether customer-response duties may run at half their normal
cadence. It never widens what an agent is allowed to do — the governor still
sits in front of every action.

| Posture  | Per agent | Per tick | Response cadence | Chosen when                                                                                          |
| -------- | --------- | -------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| idle     | 4         | 24       | normal           | nothing is waiting                                                                                   |
| steady   | 8         | 48       | normal           | ordinary queued or due work                                                                          |
| surge    | 12        | 72       | half, floor 5m   | a live P0/P1 ticket, a customer waiting, an undelivered billed period, or a queue of 12 open / 8 due |
| recovery | 3         | 18       | normal           | three consecutive failing ticks, or the tick that clears the circuit breaker                         |

A "customer waiting" is an unanswered inbound item older than thirty minutes or
a chat older than twenty. An "undelivered billed period" is a period the office
has invoiced but not yet delivered. These are facts from the office's own
tables, not a target the scheduler invents. During a surge only duties that
answer or deliver to a customer are accelerated: `foyer_intake`,
`close_win_handoff`, `close_quote_notice`, `desk_acknowledge`,
`desk_sla_watch`, `desk_chat_reply`, `desk_service_fulfilment`,
`desk_service_notice`, `ledger_payment_notices` and
`ledger_subscription_billing`.

The budgets are per tick, not per day. The per-agent cap stops one agent from
draining the whole tick; the total cap stops the tick from running until the
timer fires again. Both are recorded with the posture on `office_state`, so the
founder's autonomy panel shows the pace the scheduler actually chose rather than
reconstructing it from the queue afterwards.

```
                 ┌──────────────┐
   GET           │  /api/cron   │  Bearer CRON_SECRET, AUTONOMY=on
   /api/cron ───▶│    /floor    │  every 10 minutes
   /floor        └──────┬───────┘
                        │
                 ┌──────▼───────┐
                 │  refuse to   │  halted?  DB down?  chain broken?
                 │  run blind   │  5 failing ticks in a row?
                 └──────┬───────┘
                        │  no
                 ┌──────▼───────────┐
      36 duties → │      PLAN        │  pure function of the real office state
                 └──────┬───────────┘  returns work, or nothing
                        │
                 ┌──────▼───────────┐
                 │  work_items      │  deduped by a partial unique index
                 │  (the queue)     │  claimed atomically, backoff on failure
                 └──────┬───────────┘
                        │
                 ┌──────▼───────────┐
                 │      EXECUTE     │  every action through the governor
                 └──────┬───────────┘
                        │
                 ┌──────▼───────────┐
                 │  audit chain     │  one transaction, one lock, one head
                 └──────────────────┘
```

## The duties

Thirty-six duties, every agent has at least one, and none of them can act
outside its owner's role.

| Agent   | Duty                          | Cadence | What it does with real records                                                                                                                                                                      |
| ------- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VANTAGE | `vantage_liveness`            | 30m     | Reports an agent that has work waiting and is not working, or has never run                                                                                                                         |
| VANTAGE | `vantage_backlog`             | 60m     | Reports a stuck queue and anything abandoned after retries                                                                                                                                          |
| VANTAGE | `vantage_briefing`            | 24h     | One factual daily summary for the founder: books, pipeline, queue, last day's activity — every figure from a record                                                                                 |
| FOYER   | `foyer_intake`                | 10m     | Classifies unrouted enquiries into a lead or a service ticket                                                                                                                                       |
| FOYER   | `foyer_stale_intake`          | 60m     | Escalates an enquiry nobody answered after four hours                                                                                                                                               |
| SIGNAL  | `signal_site_signals`         | 12h     | Reads real recorded page views and says what they mean                                                                                                                                              |
| SIGNAL  | `signal_content_brief`        | 24h     | Briefs the next owned-site piece, or names pages with no traffic                                                                                                                                    |
| SIGNAL  | `signal_draft_campaign`       | 168h    | Drafts one owned-channel campaign per week for nurtured leads not yet in sales. Activation is a founder approval.                                                                                   |
| SIGNAL  | `signal_prospect`             | 24h     | Flags repeat visits to buying pages as a `Prospect ·` lead. No contact is invented.                                                                                                                 |
| SIGNAL  | `signal_qualify_leads`        | 3h      | Scores every lead on what the buyer actually wrote                                                                                                                                                  |
| SIGNAL  | `signal_handoff`              | 2h      | Files a founder-gated sales handoff for genuine buying intent                                                                                                                                       |
| CLOSE   | `close_discovery`             | 4h      | Opens a qualified lead that came in through a real channel, and writes a discovery checklist against a live opportunity                                                                             |
| CLOSE   | `close_quote`                 | 60m     | Issues a published-rate quote for a real enquiry when a delegation covers quoting. The line comes from the quote playbook, never from the model.                                                    |
| CLOSE   | `close_quote_followup`        | 12h     | Drafts a follow-up once a real quote has waited two days                                                                                                                                            |
| CLOSE   | `close_stale_proposal`        | 24h     | Reports a proposal with no movement for fourteen days                                                                                                                                               |
| CLOSE   | `close_win_handoff`           | 60m     | Flags a won deal with delivery open and no invoice                                                                                                                                                  |
| CLOSE   | `close_quote_notice`          | 2h      | Emails an approved quote the customer has not received, with the link they can accept it on. Only under a delegation that allows customer email and covers quoting.                                 |
| DESK    | `desk_acknowledge`            | 30m     | Drafts an acknowledgement for an unanswered service request                                                                                                                                         |
| DESK    | `desk_sla_watch`              | 2h      | Escalates tickets past their severity's time limit                                                                                                                                                  |
| DESK    | `desk_chat_reply`             | 15m     | Drafts a reply to a chat that has been waiting                                                                                                                                                      |
| DESK    | `desk_service_fulfilment`     | 60m     | Produces the deliverable for an invoiced period from the office's own records and files it as a document. The agent never writes it.                                                                |
| DESK    | `desk_service_notice`         | 60m     | Emails the customer the report for a delivered period, from the office's own template, to an address already on file                                                                                |
| FORGE   | `forge_diagnose`              | 30m     | Writes a procedure against an open fault. Never marks it fixed                                                                                                                                      |
| FORGE   | `forge_knowledge`             | 24h     | Turns a resolved fault's procedure into knowledge-base text                                                                                                                                         |
| LEDGER  | `ledger_chase_invoice`        | 24h     | Drafts a reminder for an invoice unpaid after seven days                                                                                                                                            |
| LEDGER  | `ledger_payment_notices`      | 2h      | Matches a payment notice to an invoice to the cent and books the receipt, or puts the notice in front of the founder                                                                                |
| LEDGER  | `ledger_payables`             | 24h     | Reports money owed out, for the founder to schedule                                                                                                                                                 |
| LEDGER  | `ledger_start_subscription`   | 4h      | Starts the subscription a customer bought: a won opportunity with an accepted quote for a recurring plan and no subscription yet                                                                    |
| LEDGER  | `ledger_subscription_billing` | 60m     | Invoices each subscription whose own billing date has passed, using the period the subscription says                                                                                                |
| LEDGER  | `ledger_dunning`              | 4h      | Reminds a customer about an invoice open for seven days or more, and only while a delegation allows it. After nine weeks the office stops emailing about it and the invoice is left to the founder. |
| LEDGER  | `ledger_billing`              | 30m     | Invoices won work with an accepted quote, then sends the invoice and, once money is matched, the receipt. Only under a delegation that covers billing and customer email.                           |
| KEEP    | `keep_records`                | 12h     | Reports a won deal with no quote, invoice or receipt filed                                                                                                                                          |
| KEEP    | `keep_subscription_review`    | 168h    | Reviews the recurring-revenue book weekly: subscriptions past their billing date, and whether the published prices still match the plans the office sells                                           |
| SEAL    | `seal_chain_verify`           | 12h     | **Halts the office** if the audit chain does not verify                                                                                                                                             |
| SEAL    | `seal_scope_audit`            | 24h     | Reports escalations that suggest an agent is unsure of its role                                                                                                                                     |
| SEAL    | `seal_chain_anchor`           | 24h     | Records the audit-chain head once a day as an external witness, so a later rewrite of the chain can be detected                                                                                     |

## What autonomy is allowed to do

Every duty action goes through the same constitutional governor as a manual
dispatch. Without a delegation in place, the standing boundary is the one the
office has always had:

**Agents may** — file leads, open tickets, write drafts, advance records the
founder has already authorised, score, and file internal briefs.

**Agents may not** — email a customer, spend money, win or lose a customer, issue
an invoice, or publish anything. Each of those is an escalation, and every
escalation is a founder approval with the constitutional trace attached.

That is the default, and the office ships with it. ART-13 lets the founder
change it once, in advance, for a bounded class of work. A delegation is the
founder writing down: "for these action kinds, at these published prices, up to
this much for any single action and this many times a day and a month, you may
act and bill without asking me again."

Inside that envelope the office acts and bills on its own. Outside it, nothing
changes: the same gate, the same escalation, the same constitutional trace.

Five things stay impossible, delegation or no delegation:

1. **Emailing a customer without a delegation that allows it.**
   `send_customer_mail` is one of only four action kinds that exist solely under
   a delegation, and the policy must both list it and set the customer-mail
   flag. The body is rendered from a template written in `customer-mail.ts`; an
   agent never supplies the wording. The rendered body is checked once more
   before it is allowed out, and a body containing a promise word — guarantee,
   uptime, 24/7, SLA, fixed price, discount, free — is not sent at all. Without
   a delegation, customer letters are drafted, never sent.
2. **Charging anyone without an accepted quote or a won job.** `issue_invoice`,
   `record_inbound_payment` and `start_subscription` are money actions, and each
   is refused unless the customer has an accepted quote on file or a won
   opportunity. A delegation may demand that of every action it covers. The
   check reads the whole table, never a window.
3. **Quoting a price that is not on the published card.** The governor re-prices
   the quote from the published rate and refuses any amount that does not match
   it. A delegation may only name rate lines that exist and are offered; a
   withheld line can never be delegated, and the office checks weekly that the
   published prices still match the plans it sells.
4. **Selling to a customer who never contacted us.** `open_opportunity`,
   `issue_quote` and `propose_close_won` need a real enquiry — a row in the
   inbound log for that company name. A lead the office invented from a page
   view has none, and no delegation reaches it.
5. **Approving an unanswered approval on a timer.** An escalation is resolved
   by the founder, in the office, one decision at a time. Nothing expires an
   approval into a decision, and no delegation creates one.

## Delegated authority (ART-13)

ART-13 is the one article that lets the founder satisfy the founder gate once,
in advance, for a class of action instead of once per action. A delegation is
deliberately boring. It names:

- the action kinds it covers, from a closed list of nine — `open_opportunity`,
  `issue_quote`, `propose_close_won`, `issue_invoice`,
  `record_inbound_payment`, `start_subscription`, `cancel_subscription`,
  `fulfil_service`, `send_customer_mail`;
- the published rate lines it may charge;
- the most any single action may be worth;
- how many actions it may take per day, and how many per month.

When the founder starts a delegation the defaults are R5,000.00 for a single
action, 20 actions a day and 200 a month. The founder may set any of them, and
the monthly limit may not be smaller than the daily limit. There is one
delegation: it is edited, paused and revoked, never duplicated. It is managed on
`/office/delegations`.

**What a delegation can never override.** It does not weaken the constitution. It
cannot widen an agent's role, cannot permit a promise to a customer, cannot
permit a price that is not published, and cannot survive a halt. The delegation
check runs after the absolute blocks, so it can never rescue an action that was
already refused for role separation, human dignity, instruction override or
non-discrimination reasons. Four action kinds exist only under a delegation —
`fulfil_service`, `start_subscription`, `cancel_subscription` and
`send_customer_mail` — and without one they are refused rather than escalated.

A founder action is not a delegated action. The delegation is read only for
work the office does on its own, so a founder's own action never spends the
office's autonomous budget, and the caps always measure autonomous work.

**Revocation takes effect on the very next action.** The policy is read fresh
inside the same transaction that performs the action, so a revoked delegation is
refused with `revoked` and a paused one with `paused` before anything is
written. There is no grace period and no queue of work that was already
approved: the next tick sees the change.

**Usage is counted from real rows.** Every action taken under a delegation
writes a `delegation_usage` row in the same transaction that took the action,
carrying the action kind, the amount, the company and the UTC day and month.
The caps are a count over those rows rather than a counter in memory, so a
retried tick cannot slip past a cap and a restart cannot reset one.

The office can pause a delegation without ending it, and the presets on
`/office/delegations` are four starting points: Observe only, Deliver and tell
the customer, Bill and collect, and Managed revenue. None of them is on by
default.

## Recurring revenue

A recurring plan is a quote, an acceptance and a schedule. The office can run
the whole loop on its own, once a delegation covers it.

1. **Quote.** The price comes from the published rate card and from nothing
   else.
2. **The customer accepts on their link.** The quote reaches the customer as a
   link, valid for thirty days. The customer accepts by name on the link. That
   one action closes the opportunity as won, marks the quote accepted and opens
   the delivery ticket — idempotently, so a double click cannot open two.
3. **The office starts the subscription.** A won opportunity with an accepted
   quote for a recurring plan, and no subscription yet, becomes a subscription.
   If the price on the quote does not match the published plan price, nothing
   is started. The period the customer bought is the first one, and the
   subscription recurs from the day that period ends, so nobody is billed
   twice for the same month.
4. **The period is invoiced.** When the subscription's own next billing instant
   arrives, the billing duty plans one work item for it. The period boundaries
   come from the subscription, not from a window the office chose. The invoice
   goes through the governor like any other invoice, so the delegation caps and
   the money guards apply exactly as they do to a founder-raised invoice.
5. **The deliverable is produced from the office's own records.** The report is
   assembled from tickets, quotes, invoices, support time and measured response
   times, and filed as a document. When the founder has logged support time for
   the period, the report uses it; otherwise it labels the remote-hours figure as
   an estimate. The agent asks for the deliverable and the office
   produces it; it never writes the customer's text. Where the office holds no
   record of something, the report says so rather than filling the gap.
6. **The customer is emailed.** The notice duty sends the report to an address
   the office already holds for that customer, rendered from the office's own
   template. The notice is written down before the send, and the send happens
   after the transaction commits, so a slow mail server cannot hold the audit
   lock open. A notice that could not be sent stays on file as `not_delivered`
   with the reason.
7. **The payment is matched and the receipt is booked.** The customer files a
   payment notice. If it carries a reference on an open invoice and an amount
   that matches to the cent, the receipt is booked, the invoice is marked paid
   and the period is closed. Anything that does not match exactly goes to the
   founder, and treasury does not move.

Which of those steps need a person:

- **Autonomous once the delegation is in place:** the quote notice, the invoice
  for the period, the deliverable, the customer email, the payment reminder,
  and the matching of an exact payment to an invoice.
- **Still a person's decision:** anything above the delegation's cap, anything
  the delegation does not cover, every refund or credit, every concession to a
  customer, and every customer win or loss the delegation does not cover. The
  office never ends a subscription on its own initiative: no duty plans a
  cancellation, and the founder ends one from the office.
- **Only possible under a delegation:** every step in the list above. With no
  delegation the same flow stops at the founder gate at each step — the quote
  is approved by hand, the invoice is raised by hand, the report is produced by
  hand, and the email is drafted rather than sent.

## What stops it

Five independent brakes, any one of which is sufficient:

1. **Halt.** The founder can halt from the office shell or the API. No duty
   plans anything while halted, and a halted office refuses queued approvals.
2. **Database health.** A tick refuses to run if the database is unreachable or
   the schema is missing, rather than planning work it cannot record.
3. **The audit chain.** Every tick refuses ordinary work when the chain does not
   verify: only SEAL runs, and the seal duty halts the office. SEAL also verifies
   the whole hash chain on its twelve-hour cadence, because an office that cannot
   prove what it did must not keep acting.
4. **A circuit breaker, with a self-check.** Five consecutive failing ticks and
   the scheduler refuses to act. After a thirty-minute cooldown it may make one
   clean probe — the real database, the chain and the halt state — and if they
   are healthy it clears the breaker, writes `scheduler_recovered` to the audit
   chain and resumes at the recovery budget. If the probe is not clean, the
   breaker stays closed. Three consecutive failures already slow the office to
   the recovery budget before the breaker trips.
5. **The governor.** Role separation, published pricing, dignity,
   non-discrimination, confidence floors, and the founder gates on cost, customer
   win, customer loss and marketing-to-sales handoff — applied to every single
   action, autonomous or not, and satisfied in advance only where a delegation
   says so.

## Idempotency

The scheduler runs on a timer that retries, on multiple serverless instances,
can be triggered by hand at the same moment, and is nudged opportunistically
when a public surface (a health poll, a page-view beacon) sees that the last
tick is more than ten minutes old. Three mechanisms make all of that safe:

- A **partial unique index** on `work_items.dedupe_key where status = 'open'`
  means a recurring duty can never stack two open items for the same record. The
  database rejects the duplicate, not a check-then-insert race.
- Work is **claimed atomically** (`update ... where status = 'open'`), so two
  ticks cannot run the same item.
- Money guards query the **whole table**, never the windowed snapshot the UI
  renders from. The old code checked "is there already an invoice for this
  opportunity?" against the 80 most recent ledger rows, so past 80 rows it
  stopped protecting the books.

A billing period is invoiced once. The unique index on
`(subscription_id, period_start)` and a conditional claim inside the invoice
transaction mean that a retried tick, a restarted server and two concurrent
ticks cannot bill the same month twice.

`scripts/verify-office.mjs` runs the floor again and again past its own
cadences, and asserts that no invoice is booked twice and no quote is
duplicated.

## Money

- Amounts are integer cents throughout. No float arithmetic on money.
- A receipt may only retire money that is actually owed. Crediting more than the
  outstanding receivable is impossible, because the balance update and the
  ledger row happen in one transaction that reads the receivable under lock.
- An invoice is bound to won work: a job invoice to a won opportunity, a
  recurring invoice to the billing period it covers. A quote's figure is
  generated from `QUOTE_SPECS`, never from anything an agent wrote.
- A delegated action may only charge a published rate line, and the delegation's
  own cap applies on top of it. The office never prices a plan from a figure it
  invented: a plan whose published price has drifted from the rate card is
  reported, and a subscription whose quoted price does not match the published
  plan price is not started.

## Running it

```sh
AUTONOMY=on CRON_SECRET=$(openssl rand -hex 32)   # in the host environment
```

Then either press **Run the floor** on `/office` — the same code path — or wait
for the schedule. The schedule alone is not enough: GitHub throttles frequent
cron on quiet repositories, so a hit on `/api/health`, the page-view beacon, or
the founder loading the floor also starts a catch-up tick when the last one is
over ten minutes old. A monitor polling health therefore doubles as the
heartbeat. `/api/health` reports whether it is actually running:

```sh
curl -s https://www.vantage-ars.co.za/api/health | jq '.scheduler, .problems'
```

## Proving it works

```sh
npm run verify:office
```

This boots the real application modules against a real embedded Postgres, files
the records the public site would really file, runs the real scheduler, and
asserts on what the real agents actually did — 231 checks, no mocks, no
fixtures.
