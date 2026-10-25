# Vantage-ARS

The public website and founder-controlled, AI-staffed office for Vantage-ARS
([vantage-ars.co.za](https://vantage-ars.co.za)): VoIP, networking and IT
infrastructure support, South Africa.

Author: Juan-louw Greyling <juanlouw.greyling@gmail.com>

## Stack

- TanStack Start + React 19, Tailwind CSS 4, Vite 8, Nitro 3
- Postgres: Neon (or any Postgres) when `DATABASE_URL` is set, otherwise embedded PGLite
- Better Auth (founder email and password), pdf-lib for quotes, Gmail SMTP for notices
- Ten AI staff, each with a fixed role, working a durable queue on their own cadence
- Nine productised services at published prices, and a standing founder delegation (ART-13) that lets the office deliver and bill them unattended

## What is in it

| Area                | Routes                                                                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public site         | `/`, `/services`, `/services/voip`, `/services/networking`, `/services/it-infrastructure`, `/services/managed-support`, `/services/cloud-email`, `/services/security`, `/services/backup-recovery`, `/find`, `/guides`, `/rates`, `/work`, `/support`, `/status`, `/terms`, `/privacy` |
| Customer quote link | `/q/<token>`: view, download PDF, accept or decline                                                                                                                                                                                                                                    |
| Founder office      | `/office`: command, autonomy, approvals, sales, ledger, customer book, site signals, chat, audit, metrics and more                                                                                                                                                                     |
| Founder governance  | `/office/delegations` (standing delegation), `/office/governance` (rulings, section 71 gates, signed receipts), `/office/revenue` (subscriptions, billing, customer mail), `/office/customers` (the customer book)                                                                     |
| Operations          | `/status` (public readiness), `/api/health` (liveness), `/api/cron/floor` (scheduled run), `/api/ai/status`                                                                                                                                                                            |

## The office runs itself

With `AUTONOMY=on` and a `CRON_SECRET`, ten agents work a durable queue every
ten minutes. Each has named duties on their own cadence: reception classifies
enquiries, marketing scores leads on what the buyer actually wrote, flags repeat
site interest as prospects, and drafts weekly owned-channel campaigns, then files
a founder-gated handoff when demand is real; sales drafts real follow-ups on real
quotes, the service desk drafts acknowledgements, technical writes procedures,
finance chases overdue invoices, bills the subscriptions that are due and duns
the ones that are not, admin checks the filing and reviews the recurring-revenue
book, the orchestrator briefs you once a day from the books, and compliance halts
the office if the audit chain ever fails to verify.

None of them email a customer, spend money, win or lose a customer, or publish
anything. Those are founder approvals, with the constitutional trace attached —
unless you have granted a standing delegation.

Full detail, including every duty and every brake: **[docs/autonomy.md](docs/autonomy.md)**.

## Standing delegation (ART-13)

Nothing is delegated by default. The office ships with no delegation at all, and
it stops at the founder gate for every cost, every customer win, every customer
loss and every marketing-to-sales handoff.

A delegation is the founder answering a whole class of question in advance:
"for this bounded class of action, at this price, up to this many times a day,
you may act without asking me again." It names the action kinds it covers, the
published rate lines it may charge, the most any single action may be worth, and
how many actions it may take per day and per month. It is revocable, and
revocation takes effect on the very next action.

A delegation never overrides a hard block. It cannot widen an agent's role,
permit a price that is not published, permit a promise to a customer, or survive
a halt. Every action taken under one is written into the audit chain against the
delegation that allowed it.

The founder sets it at **`/office/delegations`**. Four presets are offered, and
none of them is on until it is saved.

## Productised services and recurring revenue

Nine services are published with a fixed scope, a fixed price and a
deliverable the office can produce from its own records: the managed support
plan and the remote health and spend watch, both monthly; the quarterly
infrastructure review; and the service report, the billing and rate compliance
audit, the infrastructure documentation and handover pack, the business
continuity plan, the service level and response review and the fault pattern
and incident review, all one-off.

Because the office can deliver them and can bill them, they are recurring
revenue rather than jobs. A subscription bills on its own cycle, the
deliverable is compiled from the office's own records, and the customer is sent
their report and their invoice. Every email the office sends is kept in full
under `customer_notices`.

None of it happens on its own. The office delivers and bills a plan only under
a delegation, and emails a customer only under a delegation that allows mail.
The book is at **`/office/revenue`**; the plans and their prices are on
**`/rates`** and **`/services/managed-support`**.

The customer book at **`/office/customers`** assembles every company the office
has actually touched — enquiry, lead, opportunity, invoice, receipt and
subscription — into one account with its status, open balance and monthly value.
It exports the book as CSV. It does not invent a customer from a page view.

Support time is logged at **`/office/service`** against the account, with the
minutes, a note and the work date. A service report uses that recorded time when
it exists and falls back to the one-hour-per-fault estimate, labelled as an
estimate, when it does not. The ledger journal and the combined audit/decision
chain also export as formula-safe CSV.

The governance record at **`/office/governance`** brings together the founder's
precedent rulings, section 71 gate records and signed execution receipts. Each
receipt signature is checked at read time; an approval that was skipped stays
visibly undecided at the gate. Ctrl/⌘ K opens office-wide search across the
founder snapshot — customers, approvals, tickets, money records, decisions and
pages — without exposing a public index.

**`/find`** asks three plain questions — the problem, the impact and the horizon
— and recommends a published service, the guides that explain it and a short
checklist before an enquiry. It recommends; it does not quote or promise an
outcome.

Marketing at **`/office/marketing`** also shows the last thirty days of real
site signals: page views by day, top pages, referral sources, countries and the
latest events. The record holds no IP address, no cookie and no inferred
identity, and the panel reports only what was recorded.

## Run locally

Node 22.12 or newer.

```sh
npm ci
cp .env.example .env      # fill in what you need; everything is optional locally
npm run dev               # http://localhost:8080
npm run validate          # typecheck + lint + tests
npm run verify:office     # boots a real office and proves it runs autonomously
```

`npm run verify:office` is the one that matters. It starts a real embedded
Postgres, files the records the public site would really file, runs the real
scheduler, and asserts on what the real agents did — 231 checks, no mocks and
no sample data. If autonomy breaks, this fails.

## Environment

Everything is in [`.env.example`](.env.example). The ones that matter:

| Variable                                                        | Purpose                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                  | Postgres (Neon). Migrations run during `npm run build`. Unset means embedded PGLite. |
| `PGLITE_DATA_DIR`                                               | With PGLite, keep data here. Unset means in-memory, lost on restart.                 |
| `BETTER_AUTH_URL`                                               | The public URL.                                                                      |
| `BETTER_AUTH_SECRET`                                            | A long random secret (`openssl rand -base64 32`). Required in production.            |
| `FOUNDER_SETUP_TOKEN`                                           | One-time code for creating the founder account. Remove it afterwards.                |
| `FOUNDER_EMAIL`                                                 | The only account allowed into the office.                                            |
| `AUTONOMY`                                                      | `on` lets the office act unattended. Anything else and only the button works.        |
| `CRON_SECRET`                                                   | Bearer token the scheduler must present. 16+ characters.                             |
| `GMAIL_SMTP_USER`, `GMAIL_SMTP_APP_PASSWORD`                    | Founder notices.                                                                     |
| `FOUNDER_WEBHOOK_URL`                                           | Optional HTTPS webhook for the same founder notices (Slack, Discord or generic).     |
| `PAYMENT_*`                                                     | Bank details on the site and quotes.                                                 |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` / `XAI_API_KEY` | AI staff reasoning. Every autonomous duty works without it.                          |

Nothing new is needed for the delegation or the productised services. A
delegation is set inside the office, and customer email uses the same
`GMAIL_SMTP_USER` and `GMAIL_SMTP_APP_PASSWORD` as founder notices.

## Founder setup (once)

1. Set `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `FOUNDER_SETUP_TOKEN` and, if needed, `FOUNDER_EMAIL`. Deploy.
2. Open `/office`. The page offers "First-time founder setup".
3. Enter the founder email, a password of 12+ characters and the setup token.
4. Remove `FOUNDER_SETUP_TOKEN` and redeploy. Sign-up is closed once a founder exists.

## Deploy

**[docs/deploy-vercel.md](docs/deploy-vercel.md) is the full walkthrough** — the
variables to set, the founder setup, the domain cutover, and how to verify it.

### Vercel + Neon (recommended)

1. Import the GitHub repo in Vercel.
2. Add a Neon database and set `DATABASE_URL`, then the auth settings above.
3. Set `AUTONOMY=on` and a generated `CRON_SECRET`. The ten-minute tick is
   scheduled by the `office-scheduler` GitHub Actions workflow — add the same
   `CRON_SECRET` as a repository secret (Settings → Secrets and variables →
   Actions) so the scheduler call authenticates. GitHub's cron is best-effort
   on quiet repositories, so the office also nudges itself: a hit on
   `/api/health` or a real page view starts a catch-up tick when the last one
   is over ten minutes old. `vercel.json` keeps a daily run as the final
   fallback (Vercel's Hobby plan rejects crons more often than daily).
4. Deploy. `npm run build` applies migrations.
5. Check `https://www.vantage-ars.co.za/api/health` — `scheduler.overdue` should
   be `false`.

### Docker (any server)

```sh
cp .env.example .env      # set AUTONOMY=on, CRON_SECRET, auth settings
docker compose up -d --build
```

The compose file also starts a `scheduler` sidecar that ticks
`/api/cron/floor` every ten minutes with your `CRON_SECRET`, so an unattended
server never depends on GitHub Actions cron.

### Plain Node

```sh
npm ci && npm run build && npm start      # .output/server/index.mjs, PORT defaults to 3000
```

For an always-on server without Docker, `deploy/systemd/` ships a service unit
plus a timer that ticks the floor every ten minutes.

## Operations

**Health.** `GET /api/health` answers "is the business running?" — database,
audit chain, scheduler freshness, work queue, mail delivery, and the money
position. It returns 503 when something that matters is wrong, and never exposes
a secret or a customer. Sign in and it returns the full picture. Hitting it also
nudges a stale scheduler back on cadence, so an uptime monitor doubles as the
heartbeat.

**Public status.** `/status` is a readiness check, not an uptime page: five
lines read from the office at the moment it loads — records, decision-record
integrity, scheduled work, published-rate agreement and founder control. The
full health document is reduced on the server, so money, customers, the halt
reason and delegation limits never reach a visitor. It keeps no history and
makes no availability promise.

**Autonomy UI.** `/office` shows the scheduler state, every duty and when it is
next due, the live queue, and what each agent did last. The same panel runs the
office on demand through the identical code path. It also lists the
dead-letter queue on its own, with the error that killed each item, and lets
the founder redrive one: redriving is a founder action, never an automatic one,
and it is written to the audit chain.

**Money.** Amounts are integer cents. A receipt may only retire money actually
owed — the balance update and the ledger row are one transaction that reads the
receivable under lock. A quote's figure is generated from the published rate
card, never from agent prose.

**Audit chain.** Every decision and every event is hash-chained in one
transaction under an advisory lock, so the chain cannot fork. SEAL verifies the
whole chain twice a day and halts the office if it fails. `/office/audit` shows
the result.

**Backup.** `/office/audit` exports every business table as JSON with a SHA-256
checksum, including live customer quote links. Restore is add-only and
transactional: it never deletes or overwrites, and a half-restored office is
impossible.

## CI

`.github/workflows/ci.yml` runs typecheck, lint, tests, a production build and
the office verification on every push to `main` and every pull request.

## Docs

- [docs/autonomy.md](docs/autonomy.md): every duty, every brake, and why.
- [docs/autonomy-runbook.md](docs/autonomy-runbook.md): the switches that make the office run itself, per deploy target.
- [docs/autonomy-roadmap.md](docs/autonomy-roadmap.md): what is verified running today, and the ordered increments to a fully unattended office.
- [docs/governance-architecture.md](docs/governance-architecture.md): the five planes, the risk tiers, the dead-letter queue, and what is deliberately not implemented.
- [docs/deploy-vercel.md](docs/deploy-vercel.md): environment, cutover, verification.
- [docs/business-scope-and-competitive-pricing.md](docs/business-scope-and-competitive-pricing.md): scope, rates and department boundaries.
- [docs/cloudflare-workers-ai.md](docs/cloudflare-workers-ai.md): account id, API token, per-host env, verification.
- [docs/MERGE.md](docs/MERGE.md): how the earlier projects were combined.
- [CHANGELOG.md](CHANGELOG.md): what changed and when.

## Governance

Agents act only inside their role. Anything that costs money, risks a customer,
or can win one goes to the founder for approval, unless a standing delegation
covers it. Every decision is recorded in a hash-chained audit trail that the
office verifies on its own.

The founder's own rulings are recorded too, and in more detail than the chain
alone: the risk tier of the decision, the POPIA section 71 test and its
answers, the material conditions the ruling was made under, and a signed
receipt for the execution. A precedent is evidence, never authority — nothing
in the code reads a past approval to permit a present action.

How the office is bounded, and what it does not do:
**[docs/governance-architecture.md](docs/governance-architecture.md)**.

<!-- omgithub:readme:start -->
## 🚀 Build, play, and remix with OMGithub

**Remixed using [OMGithub.com](https://omgithub.com).**

[![OMGithub](https://img.shields.io/badge/OMGithub-Open%20project-orange?style=for-the-badge)](https://omgithub.com/arsvantage-source/vantage-ars)
[![GitHub](https://img.shields.io/badge/GitHub-Source-181717?logo=github&style=for-the-badge)](https://github.com/arsvantage-source/vantage-ars)

- 🎮 [Open the project](https://omgithub.com/arsvantage-source/vantage-ars).
- ✨ [Remix this project](https://omgithub.com/?remix=arsvantage-source%2Fvantage-ars).
- 💻 [Explore the source](https://github.com/arsvantage-source/vantage-ars).
- 🛠️ [Check build runs](https://github.com/arsvantage-source/vantage-ars/actions).
- 🐛 [Report an issue](https://github.com/arsvantage-source/vantage-ars/issues).
- 👤 [Explore the creator's projects](https://omgithub.com/arsvantage-source).
- 🌍 [Create with OMGithub](https://omgithub.com).
- 🧬 [Explore the remix source](https://github.com/arsvantage-source/vantage-ars).
<!-- omgithub:readme:end -->
