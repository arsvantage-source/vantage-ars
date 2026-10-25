import { createFileRoute } from "@tanstack/react-router";
import { logInboundItem } from "@/lib/office/store.server";

export const Route = createFileRoute("/api/inbound-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            from?: string;
            subject?: string;
            text?: string;
            companyName?: string;
          };
          const companyName = (body.companyName || body.from || "Unknown").trim().slice(0, 160);
          const subject = (body.subject || "(no subject)").trim().slice(0, 200);
          const summary = (body.text || "").trim().slice(0, 4000);
          const id = await logInboundItem({
            channel: "email",
            companyName,
            subject,
            summary: `From: ${body.from ?? "unknown"}\n\n${summary}`,
            intent: "enquiry",
          });
          return new Response(JSON.stringify({ ok: true, id }), {
            status: 201,
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
