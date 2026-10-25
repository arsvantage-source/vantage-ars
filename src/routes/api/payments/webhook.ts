import { createFileRoute } from "@tanstack/react-router";
import { findInvoiceForReference, recordInvoiceReceipt } from "@/lib/office/store.server";

export const Route = createFileRoute("/api/payments/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            reference?: string;
            amountCents?: number;
          };
          const reference = String(body.reference ?? "").trim();
          if (!reference) {
            return new Response(JSON.stringify({ ok: false, error: "reference is required" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          const matched = await findInvoiceForReference(reference);
          if (!matched) {
            return new Response(JSON.stringify({ ok: false, error: "no single matching invoice" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          if (body.amountCents !== undefined && Number(body.amountCents) !== matched.amountCents) {
            return new Response(
              JSON.stringify({ ok: false, error: "amount does not match the invoice" }),
              { status: 409, headers: { "content-type": "application/json" } },
            );
          }
          const result = await recordInvoiceReceipt(matched.id);
          return new Response(JSON.stringify(result), {
            status: result.ok ? 200 : 409,
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          return new Response(
            JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      },
    },
  },
});
