import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DUTY_CADENCE_MINUTES,
  DUTY_OWNER,
  planDuty,
  rateCardIntegrity,
  scoreLead,
  PRICE_GUIDE,
  type DutyId,
  type DutyView,
} from "./duties.ts";
import { AGENT_BY_ID } from "./agents.ts";

const NOW = new Date("2026-03-14T09:00:00.000Z").toISOString();

function hoursAgo(hours: number): string {
  return new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
}
function daysAgo(days: number): string {
  return hoursAgo(days * 24);
}

function view(overrides: Partial<DutyView> = {}): DutyView {
  return {
    now: NOW,
    halted: false,
    inbound: [],
    leads: [],
    opportunities: [],
    quotes: [],
    subscriptions: [],
    billingCycles: [],
    delegation: null,
    tickets: [],
    ledger: [],
    documents: [],
    notices: [],
    campaigns: [],
    approvalsPending: [],
    agents: [],
    siteEvents: [],
    chatThreads: [],
    quoteLinks: [],
    treasuryCents: 0,
    receivableCents: 0,
    payableCents: 0,
    publishedPathCount: 9,
    chainIntact: true,
    work: [],
    ...overrides,
  };
}

function delegation(
  overrides: Partial<NonNullable<DutyView["delegation"]>> = {},
): NonNullable<DutyView["delegation"]> {
  return {
    id: "primary",
    label: "Managed revenue",
    status: "active",
    maxAmountCents: 500000,
    maxActionsPerDay: 20,
    maxActionsPerMonth: 200,
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
    allowedRateIds: ["assessment", "managed-support", "remote-support", "onsite-support"],
    allowCustomerMail: true,
    allowAutoReconcile: true,
    requireAcceptedQuote: true,
    ...overrides,
  };
}

const ALL_DUTIES = Object.keys(DUTY_CADENCE_MINUTES) as DutyId[];

describe("duty registry", () => {
  it("every duty is owned by a real agent", () => {
    for (const duty of ALL_DUTIES) {
      const owner = DUTY_OWNER[duty];
      assert.ok(AGENT_BY_ID[owner], `${duty} is owned by unknown agent "${owner}"`);
    }
  });

  it("every agent has at least one duty, so nobody idles", () => {
    const owned = new Set(ALL_DUTIES.map((duty) => DUTY_OWNER[duty]));
    for (const id of Object.keys(AGENT_BY_ID)) {
      assert.equal(owned.has(id), true, `${id} has no autonomous duty`);
    }
  });

  it("uses a positive cadence for every duty", () => {
    for (const duty of ALL_DUTIES) {
      assert.ok(DUTY_CADENCE_MINUTES[duty] >= 5, `${duty} cadence is too frequent`);
    }
  });
});

describe("duties refuse to run when the office is halted", () => {
  it("returns nothing for every duty while halted", () => {
    for (const duty of ALL_DUTIES) {
      assert.deepEqual(planDuty(duty, view({ halted: true })), [], `${duty} ran while halted`);
    }
  });
});

describe("duties never invent work", () => {
  it("returns nothing on an empty office", () => {
    // `signal_content_brief` is the one duty whose output is a plan rather than
    // a reaction to a record, so it legitimately fires once on a fresh office.
    // Its own cadence is asserted separately below.
    const planOnly: DutyId[] = ["signal_content_brief", "key_token_watch", "seal_chain_anchor"];
    for (const duty of ALL_DUTIES) {
      if (planOnly.includes(duty)) continue;
      assert.deepEqual(planDuty(duty, view()), [], `${duty} invented work from nothing`);
    }
  });

  it("asks KEY to check the token once a day and never puts a secret in the work", () => {
    const work = planDuty("key_token_watch", view());
    assert.equal(work.length, 1);
    assert.equal(work[0]?.agentId, "key");
    assert.equal(work[0]?.kind, "watch_cloudflare_token");
    assert.equal(JSON.stringify(work[0]).includes("cfat_"), false);
    assert.deepEqual(work[0]?.payload, {});
  });

  it("a content brief is written at most once a day, not once a tick", () => {
    assert.equal(planDuty("signal_content_brief", view()).length, 1);
    const today = new Date(Date.parse(NOW) - 3 * 3_600_000).toISOString();
    assert.deepEqual(
      planDuty(
        "signal_content_brief",
        view({
          documents: [
            {
              id: "d1",
              title: "brief",
              kind: "content_brief",
              status: "draft",
              relatedId: null,
              createdAt: today,
            },
          ],
        }),
      ),
      [],
    );
  });

  it("every planned item is owned by the duty's agent and carries a dedupe key", () => {
    const busy = view({
      inbound: [
        {
          id: "in1",
          channel: "web",
          companyName: "Acme",
          subject: "Need a quote",
          summary: "Email: a@b.co\nWe need help with our phone system, how much for 20 extensions?",
          intent: "enquiry",
          status: "received",
          createdAt: hoursAgo(1),
        },
      ],
      leads: [
        {
          id: "ld1",
          companyName: "Acme",
          stage: "engaged",
          score: 40,
          summary: "We need help with our phone system, how much for 20 extensions?",
          inboundId: null,
          updatedAt: hoursAgo(1),
        },
      ],
      opportunities: [
        {
          id: "op1",
          companyName: "Acme",
          stage: "discovery",
          valueCents: 0,
          summary: "Phone system",
          updatedAt: hoursAgo(1),
        },
      ],
      tickets: [
        {
          id: "tk1",
          title: "No dial tone",
          severity: "p1",
          status: "open",
          ownerAgent: "forge",
          summary: "No dial tone on the trunk",
          relatedId: null,
          updatedAt: hoursAgo(1),
        },
      ],
      ledger: [
        {
          id: "lg1",
          kind: "invoice",
          counterparty: "Acme",
          amountCents: 100000,
          status: "issued",
          relatedId: "op1",
          createdAt: daysAgo(30),
        },
      ],
      documents: [
        {
          id: "dc1",
          title: "Quote · Acme",
          kind: "quote",
          status: "approved_unsent",
          relatedId: "op1",
          createdAt: daysAgo(5),
        },
      ],
      siteEvents: [
        { kind: "page_view", path: "/rates", occurredAt: hoursAgo(2) },
        { kind: "page_view", path: "/", occurredAt: hoursAgo(3) },
      ],
    });

    for (const duty of ALL_DUTIES) {
      for (const item of planDuty(duty, busy)) {
        assert.equal(item.agentId, DUTY_OWNER[duty], `${duty} filed work for ${item.agentId}`);
        assert.ok(
          item.dedupeKey && item.dedupeKey.length > 3,
          `${duty} filed work with no dedupe key`,
        );
        assert.ok(item.reason.trim().length > 8, `${duty} filed work with no reason`);
      }
    }
  });
});

describe("lead scoring", () => {
  it("ranks a real buying enquiry above a vague one", () => {
    const buyer = scoreLead(
      "We are an office of 40 and need our PBX replaced. What would you quote for 20 extensions and a migration plan?",
      "Acme",
    );
    const vague = scoreLead("hi", "Someone");
    assert.equal(buyer.spam, false);
    assert.ok(buyer.score > vague.score, `${buyer.score} should beat ${vague.score}`);
    assert.ok(buyer.demand > 0);
    assert.ok(buyer.reasons.length > 0);
  });

  it("scores a support report as support, not as buying intent", () => {
    const fault = scoreLead(
      "Our internet is down and the phones have no dial tone since this morning.",
      "Acme",
    );
    assert.ok(fault.support > 0);
  });

  it("rejects unsolicited outreach outright", () => {
    const spam = scoreLead(
      "We offer SEO services and backlinks for your site, dear sir or madam.",
      "Spammy Co",
    );
    assert.equal(spam.spam, true);
    assert.equal(spam.score, -100);
  });

  it("is deterministic", () => {
    const text = "We need a quote for a network switch and cabling.";
    assert.deepEqual(scoreLead(text, "Acme"), scoreLead(text, "Acme"));
  });

  it("clamps to 0..100", () => {
    const loud = scoreLead(
      "URGENT ASAP our network is down we cannot work we need immediate help we need a quote now our office cannot operate",
      "Acme",
    );
    assert.ok(loud.score >= 0 && loud.score <= 100);
  });
});

describe("foyer intake", () => {
  it("files work for unrouted inbound only", () => {
    const inbound = [
      {
        id: "in1",
        channel: "web",
        companyName: "Acme",
        subject: "Quote please",
        summary: "x",
        intent: "enquiry",
        status: "received",
        createdAt: hoursAgo(1),
      },
      {
        id: "in2",
        channel: "web",
        companyName: "Beta",
        subject: "Already routed",
        summary: "x",
        intent: "enquiry",
        status: "routed",
        createdAt: hoursAgo(1),
      },
    ];
    const work = planDuty("foyer_intake", view({ inbound }));
    assert.equal(work.length, 1);
    assert.equal(work[0].payload?.inboundId, "in1");
  });

  it("skips inbound that already produced a lead or a ticket", () => {
    const work = planDuty(
      "foyer_intake",
      view({
        inbound: [
          {
            id: "in1",
            channel: "web",
            companyName: "Acme",
            subject: "x",
            summary: "x",
            intent: "enquiry",
            status: "received",
            createdAt: hoursAgo(1),
          },
        ],
        leads: [
          {
            id: "ld1",
            companyName: "Acme",
            stage: "engaged",
            score: 40,
            summary: "x",
            inboundId: "in1",
            updatedAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });

  it("escalates enquiries only once they are genuinely stale", () => {
    const fresh = {
      id: "in1",
      channel: "web",
      companyName: "Acme",
      subject: "x",
      summary: "x",
      intent: "enquiry",
      status: "received" as const,
      createdAt: hoursAgo(1),
    };
    assert.deepEqual(planDuty("foyer_stale_intake", view({ inbound: [fresh] })), []);
    assert.equal(
      planDuty("foyer_stale_intake", view({ inbound: [{ ...fresh, createdAt: hoursAgo(30) }] }))
        .length,
      1,
    );
  });
});

describe("marketing duties", () => {
  it("never hands an unqualified lead to sales", () => {
    const work = planDuty(
      "signal_handoff",
      view({
        leads: [
          {
            id: "ld1",
            companyName: "Vague Ltd",
            stage: "engaged",
            score: 10,
            summary: "just saying hello",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
          {
            id: "ld2",
            companyName: "Spam Co",
            stage: "engaged",
            score: 90,
            summary: "SEO backlinks guest post we can help you get more leads",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });

  it("hands genuinely buying demand to sales as a founder-gated handoff", () => {
    const work = planDuty(
      "signal_handoff",
      view({
        leads: [
          {
            id: "ld1",
            companyName: "Acme",
            stage: "engaged",
            score: 70,
            summary:
              "We are an office of 40 and need our phone system replaced. Could you quote for 20 extensions and a migration?",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "propose_sales_handoff");
    assert.equal(work[0].agentId, "signal");
  });

  it("does not re-propose a handoff that is already pending or already in sales", () => {
    const lead = {
      id: "ld1",
      companyName: "Acme",
      stage: "engaged",
      score: 70,
      summary:
        "We need a quote for a network switch, cabling and 20 phone extensions for our office.",
      inboundId: null,
      updatedAt: hoursAgo(1),
    };
    assert.deepEqual(
      planDuty(
        "signal_handoff",
        view({
          leads: [lead],
          approvalsPending: [
            { id: "a1", kind: "sales_handoff", title: "x", companyName: "acme", createdAt: NOW },
          ],
        }),
      ),
      [],
    );
    assert.deepEqual(
      planDuty("signal_handoff", view({ leads: [{ ...lead, stage: "in_sales" }] })),
      [],
    );
  });

  it("only briefs content when there is a real gap, at most daily", () => {
    assert.equal(
      planDuty(
        "signal_content_brief",
        view({
          documents: [
            {
              id: "d1",
              title: "brief",
              kind: "content_brief",
              status: "draft",
              relatedId: null,
              createdAt: hoursAgo(3),
            },
          ],
        }),
      ).length,
      0,
    );
    assert.equal(
      planDuty(
        "signal_content_brief",
        view({
          documents: [
            {
              id: "d1",
              title: "brief",
              kind: "content_brief",
              status: "draft",
              relatedId: null,
              createdAt: daysAgo(3),
            },
          ],
        }),
      ).length,
      1,
    );
  });

  it("reports no site signals when nobody has visited", () => {
    assert.deepEqual(planDuty("signal_site_signals", view()), []);
    assert.equal(
      planDuty(
        "signal_site_signals",
        view({ siteEvents: [{ kind: "page_view", path: "/", occurredAt: hoursAgo(1) }] }),
      ).length,
      1,
    );
  });
});

describe("sales duties", () => {
  it("only follows up on a quote that has actually been waiting two days", () => {
    const opportunity = {
      id: "op1",
      companyName: "Acme",
      stage: "proposal",
      valueCents: 161000,
      summary: "On-site support",
      updatedAt: daysAgo(5),
    };
    const quote = (createdAt: string) => ({
      id: "q1",
      title: "Quote · Acme",
      kind: "quote",
      status: "approved_unsent",
      relatedId: "op1",
      createdAt,
    });
    assert.deepEqual(
      planDuty(
        "close_quote_followup",
        view({ opportunities: [opportunity], quotes: [quote(daysAgo(0))] }),
      ),
      [],
    );
    const due = planDuty(
      "close_quote_followup",
      view({ opportunities: [opportunity], quotes: [quote(daysAgo(4))] }),
    );
    assert.equal(due.length, 1);
    assert.equal(due[0].kind, "draft_quote_followup");
    assert.equal(due[0].payload?.daysWaiting, 4);
  });

  it("records whether the customer actually opened the quote", () => {
    const work = planDuty(
      "close_quote_followup",
      view({
        opportunities: [
          {
            id: "op1",
            companyName: "Acme",
            stage: "proposal",
            valueCents: 100000,
            summary: "x",
            updatedAt: daysAgo(5),
          },
        ],
        quotes: [
          {
            id: "q1",
            title: "Quote",
            kind: "quote",
            status: "approved_unsent",
            relatedId: "op1",
            createdAt: daysAgo(4),
          },
        ],
        quoteLinks: [
          {
            documentId: "q1",
            state: "open",
            viewCount: 3,
            createdAt: daysAgo(4),
            lastViewedAt: daysAgo(1),
          },
        ],
      }),
    );
    assert.equal(work[0].payload?.views, 3);
    assert.equal(work[0].payload?.linkState, "open");
  });

  it("does not follow up on a proposal with no quote behind it", () => {
    assert.deepEqual(
      planDuty(
        "close_quote_followup",
        view({
          opportunities: [
            {
              id: "op1",
              companyName: "Acme",
              stage: "proposal",
              valueCents: 100000,
              summary: "x",
              updatedAt: daysAgo(30),
            },
          ],
          quotes: [],
          subscriptions: [],
          billingCycles: [],
          delegation: null,
        }),
      ),
      [],
    );
  });

  it("flags a proposal that has gone cold, but never closes it", () => {
    const work = planDuty(
      "close_stale_proposal",
      view({
        opportunities: [
          {
            id: "op1",
            companyName: "Acme",
            stage: "proposal",
            valueCents: 100000,
            summary: "x",
            updatedAt: daysAgo(21),
          },
        ],
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "review_cold_proposal");
    assert.equal(work[0].agentId, "close");
  });

  it("nudges for an invoice only after delivery is actually open", () => {
    const won = {
      id: "op1",
      companyName: "Acme",
      stage: "won",
      valueCents: 100000,
      summary: "x",
      updatedAt: daysAgo(3),
    };
    assert.deepEqual(planDuty("close_win_handoff", view({ opportunities: [won] })), []);
    const withTicket = planDuty(
      "close_win_handoff",
      view({
        opportunities: [won],
        tickets: [
          {
            id: "tk1",
            title: "Job",
            severity: "p3",
            status: "open",
            ownerAgent: "forge",
            summary: "x",
            relatedId: "op1",
            updatedAt: daysAgo(3),
          },
        ],
      }),
    );
    assert.equal(withTicket.length, 1);
    const invoiced = planDuty(
      "close_win_handoff",
      view({
        opportunities: [won],
        tickets: [
          {
            id: "tk1",
            title: "Job",
            severity: "p3",
            status: "open",
            ownerAgent: "forge",
            summary: "x",
            relatedId: "op1",
            updatedAt: daysAgo(3),
          },
        ],
        ledger: [
          {
            id: "lg1",
            kind: "invoice",
            counterparty: "Acme",
            amountCents: 100000,
            status: "issued",
            relatedId: "op1",
            createdAt: daysAgo(2),
          },
        ],
      }),
    );
    assert.deepEqual(invoiced, []);
  });
});

describe("autonomous quote-to-cash", () => {
  it("quotes a real enquiry from the published card under delegation", () => {
    const opportunity = {
      id: "op1",
      companyName: "Acme",
      stage: "discovery",
      valueCents: 0,
      summary: "Monthly managed support for 15 users",
      updatedAt: hoursAgo(2),
    };
    const inbound = {
      id: "in1",
      channel: "web",
      companyName: "Acme",
      subject: "Managed support",
      summary: "Email: ops@acme.example We need monthly managed support for 15 users.",
      intent: "enquiry",
      status: "received",
      createdAt: hoursAgo(2),
    };
    const work = planDuty(
      "close_quote",
      view({ opportunities: [opportunity], inbound: [inbound], delegation: delegation() }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "issue_quote");
    assert.equal(work[0].payload?.rateId, "managed-support");
    assert.ok(Number(work[0].payload?.amountCents) > 0);

    assert.deepEqual(
      planDuty("close_quote", view({ opportunities: [opportunity], inbound: [inbound] })),
      [],
      "quoting without a delegation must do nothing",
    );
    assert.deepEqual(
      planDuty("close_quote", view({ opportunities: [opportunity], delegation: delegation() })),
      [],
      "quoting a customer who did not contact the office must do nothing",
    );
  });

  it("opens a qualified lead only when the customer really contacted the office", () => {
    const lead = {
      id: "ld1",
      companyName: "Acme",
      stage: "qualified",
      score: 70,
      summary: "Email: ops@acme.example Need a network review.",
      inboundId: "in1",
      updatedAt: hoursAgo(2),
    };
    const inbound = {
      id: "in1",
      channel: "web",
      companyName: "Acme",
      subject: "Network review",
      summary: "Email: ops@acme.example Need a network review.",
      intent: "enquiry",
      status: "received",
      createdAt: hoursAgo(2),
    };
    const work = planDuty(
      "close_discovery",
      view({ leads: [lead], inbound: [inbound], delegation: delegation() }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "open_sales_opportunity");
    assert.deepEqual(
      planDuty("close_discovery", view({ leads: [lead], inbound: [inbound] })),
      [],
      "opening an opportunity without a delegation must do nothing",
    );
  });

  it("invoices won work with an accepted quote, then sends the paperwork once", () => {
    const opportunity = {
      id: "op1",
      companyName: "Acme",
      stage: "won",
      valueCents: 275000,
      summary: "Managed support accepted",
      updatedAt: daysAgo(2),
    };
    const quote = {
      id: "q1",
      title: "Quote · Acme",
      kind: "quote",
      status: "accepted",
      relatedId: "op1",
      createdAt: daysAgo(3),
      rateId: "managed-support",
    };
    const invoiceBase = {
      id: "lg1",
      kind: "invoice",
      counterparty: "Acme",
      amountCents: 275000,
      status: "issued",
      relatedId: "op1",
      createdAt: daysAgo(1),
    };
    const invoiceDoc = {
      id: "dc1",
      title: "Invoice · Acme",
      kind: "invoice",
      status: "approved_unsent",
      relatedId: "op1",
      createdAt: daysAgo(1),
    };
    const receipt = {
      id: "lg2",
      kind: "receipt",
      counterparty: "Acme",
      amountCents: 275000,
      status: "cleared",
      relatedId: "lg1",
      createdAt: hoursAgo(2),
    };
    const inbound = {
      id: "in1",
      channel: "web",
      companyName: "Acme",
      subject: "Managed support",
      summary: "Email: ops@acme.example We need monthly managed support.",
      intent: "enquiry",
      status: "received",
      createdAt: daysAgo(5),
    };

    const invoiceWork = planDuty(
      "ledger_billing",
      view({
        opportunities: [opportunity],
        quotes: [quote],
        inbound: [inbound],
        delegation: delegation(),
      }),
    );
    assert.deepEqual(
      invoiceWork.map((item) => item.kind),
      ["issue_won_invoice"],
    );

    const notices = new Map(
      planDuty(
        "ledger_billing",
        view({
          opportunities: [opportunity],
          quotes: [quote],
          inbound: [inbound],
          ledger: [invoiceBase, receipt],
          documents: [invoiceDoc],
          delegation: delegation(),
        }),
      ).map((item) => [item.kind, item]),
    );
    assert.ok(notices.get("send_invoice_notice"));
    assert.ok(notices.get("send_receipt_notice"));
    assert.equal(notices.get("send_receipt_notice")?.payload?.receiptId, "lg2");

    const alreadySent = planDuty(
      "ledger_billing",
      view({
        opportunities: [opportunity],
        quotes: [quote],
        inbound: [inbound],
        ledger: [invoiceBase, receipt],
        documents: [invoiceDoc],
        notices: [
          {
            id: "n1",
            template: "invoice",
            status: "sent",
            relatedId: "lg1",
            companyName: "Acme",
            createdAt: daysAgo(1),
          },
          {
            id: "n2",
            template: "receipt",
            status: "sent",
            relatedId: "lg2",
            companyName: "Acme",
            createdAt: hoursAgo(1),
          },
        ],
        delegation: delegation(),
      }),
    );
    assert.deepEqual(alreadySent, []);
  });

  it("leaves the invoice nudge in place for won work with no accepted quote", () => {
    const won = {
      id: "op1",
      companyName: "Acme",
      stage: "won",
      valueCents: 100000,
      summary: "x",
      updatedAt: daysAgo(3),
    };
    const ticket = {
      id: "tk1",
      title: "Job",
      severity: "p3",
      status: "open",
      ownerAgent: "forge",
      summary: "x",
      relatedId: "op1",
      updatedAt: daysAgo(3),
    };
    const work = planDuty(
      "close_win_handoff",
      view({
        opportunities: [won],
        tickets: [ticket],
        delegation: delegation({ allowedActions: ["issue_invoice"] }),
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "nudge_invoice");
  });

  it("keeps the invoice nudge when accepted work is over the billing cap", () => {
    const won = {
      id: "op1",
      companyName: "Acme",
      stage: "won",
      valueCents: 600000,
      summary: "x",
      updatedAt: daysAgo(3),
    };
    const ticket = {
      id: "tk1",
      title: "Job",
      severity: "p3",
      status: "open",
      ownerAgent: "forge",
      summary: "x",
      relatedId: "op1",
      updatedAt: daysAgo(3),
    };
    const accepted = {
      id: "q1",
      title: "Quote · Acme",
      kind: "quote",
      status: "accepted",
      relatedId: "op1",
      createdAt: daysAgo(3),
      rateId: "managed-support",
    };
    const state = view({
      opportunities: [won],
      tickets: [ticket],
      quotes: [accepted],
      delegation: delegation({ allowedActions: ["issue_invoice"] }),
    });

    const handoff = planDuty("close_win_handoff", state);
    assert.equal(handoff.length, 1);
    assert.equal(handoff[0].kind, "nudge_invoice");
    assert.deepEqual(
      planDuty("ledger_billing", state),
      [],
      "billing must not queue work the delegation cap cannot cover",
    );
  });
});

describe("service and technical duties", () => {
  it("acknowledges a ticket once, not every tick", () => {
    const ticket = {
      id: "tk1",
      title: "No dial tone",
      severity: "p2",
      status: "open",
      ownerAgent: "desk",
      summary: "x",
      relatedId: null,
      updatedAt: hoursAgo(1),
    };
    assert.equal(planDuty("desk_acknowledge", view({ tickets: [ticket] })).length, 1);
    assert.deepEqual(
      planDuty(
        "desk_acknowledge",
        view({
          tickets: [ticket],
          documents: [
            {
              id: "d1",
              title: "ack",
              kind: "service_ack",
              status: "draft",
              relatedId: "tk1",
              createdAt: hoursAgo(1),
            },
          ],
        }),
      ),
      [],
    );
  });

  it("watches severity against age, not age alone", () => {
    const aged = (severity: string, hours: number) => ({
      id: "tk1",
      title: "Fault",
      severity,
      status: "open" as const,
      ownerAgent: "desk",
      summary: "x",
      relatedId: null,
      updatedAt: hoursAgo(hours),
    });
    assert.deepEqual(planDuty("desk_sla_watch", view({ tickets: [aged("p3", 100)] })), []);
    assert.equal(planDuty("desk_sla_watch", view({ tickets: [aged("p1", 100)] })).length, 1);
    assert.equal(planDuty("desk_sla_watch", view({ tickets: [aged("p1", 100)] }))[0].priority, 1);
    assert.deepEqual(
      planDuty("desk_sla_watch", view({ tickets: [{ ...aged("p1", 100), status: "resolved" }] })),
      [],
    );
  });

  it("diagnoses an open ticket exactly once", () => {
    const ticket = {
      id: "tk1",
      title: "No dial tone",
      severity: "p2",
      status: "open",
      ownerAgent: "forge",
      summary: "No dial tone",
      relatedId: null,
      updatedAt: hoursAgo(1),
    };
    assert.equal(planDuty("forge_diagnose", view({ tickets: [ticket] })).length, 1);
    assert.deepEqual(
      planDuty(
        "forge_diagnose",
        view({ tickets: [{ ...ticket, summary: "FORGE: already done" }] }),
      ),
      [],
    );
    assert.deepEqual(
      planDuty("forge_diagnose", view({ tickets: [{ ...ticket, status: "in_progress" }] })),
      [],
    );
  });

  it("only records knowledge from resolved tickets that have a procedure", () => {
    const resolved = {
      id: "tk1",
      title: "No dial tone",
      severity: "p2",
      status: "resolved",
      ownerAgent: "forge",
      summary: "FORGE: Check the handset registration.",
      relatedId: null,
      updatedAt: daysAgo(1),
    };
    assert.equal(planDuty("forge_knowledge", view({ tickets: [resolved] })).length, 1);
    assert.deepEqual(
      planDuty(
        "forge_knowledge",
        view({
          tickets: [resolved],
          documents: [
            {
              id: "d1",
              title: "k",
              kind: "knowledge",
              status: "recorded",
              relatedId: "tk1",
              createdAt: daysAgo(1),
            },
          ],
        }),
      ),
      [],
    );
  });
});

describe("finance duties", () => {
  it("chases an invoice only after a week with no receipt", () => {
    const invoice = (days: number) => ({
      id: "lg1",
      kind: "invoice",
      counterparty: "Acme",
      amountCents: 161000,
      status: "issued",
      relatedId: "op1",
      createdAt: daysAgo(days),
    });
    assert.deepEqual(planDuty("ledger_chase_invoice", view({ ledger: [invoice(2)] })), []);
    assert.equal(planDuty("ledger_chase_invoice", view({ ledger: [invoice(30)] })).length, 1);
    assert.deepEqual(
      planDuty("ledger_chase_invoice", view({ ledger: [{ ...invoice(30), status: "paid" }] })),
      [],
    );
  });

  it("never books a receipt on its own; it only asks the founder to confirm", () => {
    const work = planDuty(
      "ledger_payment_notices",
      view({
        inbound: [
          {
            id: "in1",
            channel: "web",
            companyName: "Acme",
            subject: "Payment",
            summary: "x",
            intent: "payment_notice",
            status: "received",
            createdAt: hoursAgo(1),
          },
          {
            id: "in2",
            channel: "web",
            companyName: "Beta",
            subject: "Payment",
            summary: "x",
            intent: "payment_notice",
            status: "filed",
            createdAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "verify_payment_notice");
  });

  it("says nothing about payables when there are none", () => {
    assert.deepEqual(planDuty("ledger_payables", view({ payableCents: 0 })), []);
    assert.equal(planDuty("ledger_payables", view({ payableCents: 5000 })).length, 1);
  });
});

describe("compliance duties", () => {
  it("halts nothing while the chain verifies", () => {
    assert.deepEqual(planDuty("seal_chain_verify", view({ chainIntact: true })), []);
  });

  it("halts the office when the chain is broken", () => {
    const work = planDuty("seal_chain_verify", view({ chainIntact: false }));
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "halt_broken_chain");
    assert.equal(work[0].agentId, "seal");
    assert.equal(work[0].priority, 0);
    assert.equal(work[0].maxAttempts, 1);
  });

  it("reports confidence escalations as possible role drift", () => {
    assert.deepEqual(planDuty("seal_scope_audit", view()), []);
    const work = planDuty(
      "seal_scope_audit",
      view({
        approvalsPending: [
          { id: "a1", kind: "constraint_margin", title: "x", companyName: null, createdAt: NOW },
        ],
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].kind, "report_scope_drift");
  });
});

describe("liveness", () => {
  it("stays quiet for an idle agent with an empty queue", () => {
    // A busy day is mostly agents with nothing to do. Reporting that as "silent"
    // trains the founder to ignore the alert that matters.
    const work = planDuty(
      "vantage_liveness",
      view({
        agents: [
          { id: "forge", callsign: "FORGE", status: "idle", lastHeartbeat: hoursAgo(5) },
          { id: "close", callsign: "CLOSE", status: "idle", lastHeartbeat: hoursAgo(0.2) },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });

  it("reports an agent that has work waiting and is not working", () => {
    const work = planDuty(
      "vantage_liveness",
      view({
        agents: [
          { id: "forge", callsign: "FORGE", status: "idle", lastHeartbeat: hoursAgo(5) },
          { id: "close", callsign: "CLOSE", status: "idle", lastHeartbeat: hoursAgo(0.2) },
        ],
        work: [
          {
            id: "w1",
            agentId: "forge",
            kind: "diagnose_ticket",
            status: "open",
            attempts: 0,
            maxAttempts: 3,
            dueAt: hoursAgo(1),
            lastError: null,
          },
        ],
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].payload?.silentAgent, "forge");
    assert.equal(work[0].payload?.waiting, 1);
  });

  it("does not count abandoned work as still waiting", () => {
    const work = planDuty(
      "vantage_liveness",
      view({
        agents: [{ id: "forge", callsign: "FORGE", status: "idle", lastHeartbeat: hoursAgo(5) }],
        work: [
          {
            id: "w1",
            agentId: "forge",
            kind: "diagnose_ticket",
            status: "abandoned",
            attempts: 3,
            maxAttempts: 3,
            dueAt: hoursAgo(9),
            lastError: "boom",
          },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });

  it("reports an agent that has never recorded a heartbeat", () => {
    const work = planDuty(
      "vantage_liveness",
      view({ agents: [{ id: "keep", callsign: "KEEP", status: "idle", lastHeartbeat: null }] }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].priority, 4, "an agent that never ran is more urgent than a slow one");
  });
});

describe("rate card integrity", () => {
  it("reads the published rate card correctly", () => {
    const verdict = rateCardIntegrity();
    assert.equal(verdict.ok, true, verdict.detail);
    assert.ok(PRICE_GUIDE.length > 5);
    const remote = PRICE_GUIDE.find((rate) => rate.id === "remote-support");
    assert.equal(remote?.cents, 69000);
    const afterHours = PRICE_GUIDE.find((rate) => rate.id === "after-hours");
    assert.ok(afterHours && afterHours.cents > 0);
  });

  it("every offered labour rate carries a usable figure", () => {
    // Travel and supplier costs are quoted per job by design and are not
    // expected to parse as a single figure.
    const quotedSeparately = /supplier|agreed|quoted/i;
    for (const rate of PRICE_GUIDE) {
      if (!rate.offered || quotedSeparately.test(rate.price)) continue;
      assert.ok(rate.cents > 0, `${rate.title} has no readable price`);
      assert.match(rate.price, /R\s*[\d]/, `${rate.title} price is not in ZAR`);
    }
  });

  it("the cheapest published labour is the remote rate the site advertises", () => {
    const labour = PRICE_GUIDE.filter((r) => r.offered && r.cents > 0);
    const cheapest = labour.reduce((a, b) => (a.cents <= b.cents ? a : b));
    assert.equal(cheapest.id, "remote-support");
    assert.equal(cheapest.cents, 69000);
    // The entry-price assessment must not undercut the hourly rate.
    const assessment = PRICE_GUIDE.find((r) => r.id === "assessment");
    assert.equal(assessment?.cents, 69000);
  });
});

describe("prospect duty", () => {
  it("plans nothing on an empty office", () => {
    assert.deepEqual(planDuty("signal_prospect", view()), []);
  });

  it("flags repeat visits to a buying path as a lead, not a customer", () => {
    const work = planDuty(
      "signal_prospect",
      view({
        siteEvents: [
          { kind: "page_view", path: "/rates", occurredAt: hoursAgo(1) },
          { kind: "page_view", path: "/rates", occurredAt: hoursAgo(5) },
          { kind: "page_view", path: "/quote", occurredAt: hoursAgo(2) },
        ],
      }),
    );
    assert.equal(work.length, 2);
    for (const item of work) {
      assert.equal(item.agentId, "signal");
      assert.equal(item.kind, "prospect_from_site_signals");
      assert.ok(item.dedupeKey.startsWith("prospect:"), item.dedupeKey);
      assert.ok(item.reason.includes("flagged interest, not a confirmed buyer"), item.reason);
      assert.equal(item.payload?.source, "site_signal");
      // The runner addresses the lead by path and count, so the payload must
      // carry them; a mismatch here once produced "Prospect · " with no path.
      const path = String(item.payload?.path ?? "");
      assert.ok(["/rates", "/quote"].includes(path), path);
      assert.equal(item.payload?.visitCount, path === "/rates" ? 2 : 1);
      assert.ok(String(item.payload?.evidence ?? "").includes(path));
    }
  });

  it("ignores pages that are not buying signals", () => {
    const work = planDuty(
      "signal_prospect",
      view({
        siteEvents: [
          { kind: "page_view", path: "/", occurredAt: hoursAgo(1) },
          { kind: "page_view", path: "/", occurredAt: hoursAgo(2) },
          { kind: "page_view", path: "/privacy", occurredAt: hoursAgo(3) },
          { kind: "page_view", path: "/terms", occurredAt: hoursAgo(4) },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });

  it("needs repeat visits to a service page before flagging it", () => {
    const once = planDuty(
      "signal_prospect",
      view({
        siteEvents: [{ kind: "page_view", path: "/services/voip", occurredAt: hoursAgo(1) }],
      }),
    );
    assert.deepEqual(once, []);
    const twice = planDuty(
      "signal_prospect",
      view({
        siteEvents: [
          { kind: "page_view", path: "/services/voip", occurredAt: hoursAgo(1) },
          { kind: "page_view", path: "/services/voip", occurredAt: hoursAgo(10) },
        ],
      }),
    );
    assert.equal(twice.length, 1);
    assert.equal(twice[0].payload?.path, "/services/voip");
    assert.equal(twice[0].payload?.visitCount, 2);
    assert.ok(String(twice[0].payload?.evidence ?? "").includes("/services/voip"));
  });
});

describe("qualify duty", () => {
  it("scores a fresh lead once, while it is still engaged", () => {
    const work = planDuty(
      "signal_qualify_leads",
      view({
        leads: [
          {
            id: "ld1",
            companyName: "Acme",
            stage: "engaged",
            score: 40,
            summary: "We need a quote for 20 extensions.",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].agentId, "signal");
    assert.equal(work[0].kind, "qualify_lead");
    assert.equal(work[0].payload?.companyName, "Acme");
    assert.equal(work[0].dedupeKey, "qualify:ld1");
  });

  it("never re-scores a lead that already has a stage", () => {
    // Scoring runs every three hours. If it kept working on decided leads it
    // would re-decide the same lead forever and churn the decision chain.
    for (const stage of [
      "nurture",
      "qualified",
      "disqualified",
      "ready_for_sales",
      "in_sales",
      "lost",
    ]) {
      const work = planDuty(
        "signal_qualify_leads",
        view({
          leads: [
            {
              id: "ld1",
              companyName: "Acme",
              stage,
              score: 40,
              summary: "We need a quote.",
              inboundId: null,
              updatedAt: hoursAgo(1),
            },
          ],
        }),
      );
      assert.deepEqual(work, [], `re-planned a ${stage} lead`);
    }
  });
});

describe("briefing duty", () => {
  it("says nothing on an empty office", () => {
    assert.deepEqual(planDuty("vantage_briefing", view()), []);
  });

  it("briefs the founder once a day when the office has real state", () => {
    const work = planDuty("vantage_briefing", view({ treasuryCents: 644000 }));
    assert.equal(work.length, 1);
    assert.equal(work[0].agentId, "vantage");
    assert.equal(work[0].kind, "report_daily_briefing");
    assert.equal(work[0].dedupeKey, `briefing:${NOW.slice(0, 10)}`);
  });

  it("is triggered by any real record, not just money", () => {
    for (const patch of [
      {
        approvalsPending: [
          {
            id: "ap1",
            kind: "sales_handoff",
            title: "Handoff",
            companyName: "Acme",
            createdAt: hoursAgo(1),
          },
        ],
      },
      {
        campaigns: [
          {
            id: "c1",
            name: "Weekly",
            channel: "owned",
            status: "draft",
            budgetCents: 0,
            spendCents: 0,
            summary: "draft",
            createdAt: hoursAgo(1),
          },
        ],
      },
      {
        documents: [
          {
            id: "d1",
            title: "Brief",
            kind: "content_brief",
            status: "draft",
            relatedId: null,
            createdAt: hoursAgo(1),
          },
        ],
      },
    ]) {
      assert.equal(planDuty("vantage_briefing", view(patch)).length, 1, JSON.stringify(patch));
    }
  });
});

describe("draft campaign duty", () => {
  it("plans nothing on an empty office", () => {
    assert.deepEqual(planDuty("signal_draft_campaign", view()), []);
  });

  it("plans nothing when there is no nurtured demand", () => {
    const work = planDuty(
      "signal_draft_campaign",
      view({
        leads: [
          {
            id: "ld1",
            companyName: "Acme",
            stage: "engaged",
            score: 40,
            summary: "x",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
          {
            id: "ld2",
            companyName: "Lost Co",
            stage: "lost",
            score: 90,
            summary: "x",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
          {
            id: "ld3",
            companyName: "In Sales",
            stage: "in_sales",
            score: 80,
            summary: "x",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });

  it("drafts one campaign for nurtured leads not yet in sales", () => {
    const work = planDuty(
      "signal_draft_campaign",
      view({
        leads: [
          {
            id: "ld1",
            companyName: "Acme",
            stage: "nurture",
            score: 30,
            summary: "x",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
          {
            id: "ld2",
            companyName: "Beta",
            stage: "qualified",
            score: 70,
            summary: "x",
            inboundId: null,
            updatedAt: hoursAgo(2),
          },
        ],
      }),
    );
    assert.equal(work.length, 1);
    assert.equal(work[0].agentId, "signal");
    assert.equal(work[0].kind, "draft_campaign");
    assert.ok(work[0].dedupeKey.startsWith("campaign:"), work[0].dedupeKey);
    assert.equal(work[0].payload?.budgetCents, 0);
    assert.equal(work[0].payload?.channel, "owned");
    const leads = work[0].payload?.leads as { companyName: string }[] | undefined;
    assert.deepEqual(
      leads?.map((lead) => lead.companyName),
      ["Acme", "Beta"],
    );
  });

  it("does not draft for a lead that already has a pending sales handoff", () => {
    const work = planDuty(
      "signal_draft_campaign",
      view({
        leads: [
          {
            id: "ld1",
            companyName: "Acme",
            stage: "nurture",
            score: 30,
            summary: "x",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
        ],
        approvalsPending: [
          {
            id: "ap1",
            kind: "sales_handoff",
            title: "Handoff",
            companyName: "Acme",
            createdAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });

  it("does not re-draft within the same week", () => {
    const weekStart = NOW.slice(0, 10);
    const work = planDuty(
      "signal_draft_campaign",
      view({
        campaigns: [
          {
            id: "c1",
            name: "Weekly",
            channel: "owned",
            status: "draft",
            budgetCents: 0,
            spendCents: 0,
            summary: "draft",
            createdAt: weekStart,
          },
        ],
        leads: [
          {
            id: "ld1",
            companyName: "Acme",
            stage: "nurture",
            score: 30,
            summary: "x",
            inboundId: null,
            updatedAt: hoursAgo(1),
          },
        ],
      }),
    );
    assert.deepEqual(work, []);
  });
});
