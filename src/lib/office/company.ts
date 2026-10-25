export const COMPANY = {
  id: "vantage-ars",
  legalName: "Vantage-ARS",
  tradingName: "Vantage-ARS",
  domain: "vantage-ars.co.za",
  jurisdiction: "ZA",
  timezone: "Africa/Johannesburg",
  currency: "ZAR",
  vatRate: 0.15,
  authorName: "Juan-louw Greyling",
  authorRole: "Constitutional Author",
  constitutionVersion: "1.1.0",
  /** Release version, kept in step with package.json by the route tests. */
  version: "5.2.0",
  autonomyLevel: "A3" as const,
  email: "juanlouw.greyling@gmail.com",
};

export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** Lower-cased company contact address; the office default login. */
export const FOUNDER_EMAIL = COMPANY.email.toLowerCase();

/**
 * The public address of the site, used for the links the office puts in
 * customer emails. Configured with BETTER_AUTH_URL; otherwise the published
 * domain, which is the address the office already publishes.
 */
export function publicBaseUrl(): string {
  const configured =
    typeof process !== "undefined" ? process.env.BETTER_AUTH_URL?.trim() : undefined;
  if (configured) return configured.replace(/\/+$/, "");
  return `https://www.${COMPANY.domain}`;
}

/**
 * The one email that opens the office. Server settings may override the
 * published address with FOUNDER_EMAIL. Lives here (not in founder-gate) so
 * server-only modules reachable from API routes can use it without pulling
 * in middleware chains. Only ever CALL in server contexts.
 */
export function founderEmail(): string {
  const configured = typeof process !== "undefined" ? process.env.FOUNDER_EMAIL?.trim() : undefined;
  return (configured || COMPANY.email).toLowerCase();
}
