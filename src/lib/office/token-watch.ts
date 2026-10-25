/**
 * What KEY is allowed to know about the Cloudflare token.
 *
 * The value is never returned, stored, or put in a reason string. A pasted
 * prefix such as `cfut_` or `cfat_` is not a dashboard API token, so it is
 * reported as unusable without repeating the secret.
 */

export type TokenShape = "missing" | "unusable" | "present";

const PASTE_PREFIXES = ["cfut_", "cfat_", "github_pat_", "ghp_", "sk-"];

export function classifyCloudflareToken(value: string | undefined): {
  state: TokenShape;
  detail: string;
} {
  const token = (value ?? "").trim();
  if (!token) {
    return { state: "missing", detail: "CLOUDFLARE_API_TOKEN is not set on the host." };
  }
  const prefix = PASTE_PREFIXES.find((item) => token.startsWith(item));
  if (prefix) {
    return {
      state: "unusable",
      detail: `The token starts with ${prefix}, which is not a Cloudflare dashboard API token. The value was not recorded.`,
    };
  }
  if (token.length < 20) {
    return {
      state: "unusable",
      detail:
        "The token is too short to be a Cloudflare dashboard API token. The value was not recorded.",
    };
  }
  return {
    state: "present",
    detail: `A token is set (${token.length} characters). Its value was not recorded.`,
  };
}

export type TokenVerdict = {
  state: "missing" | "unusable" | "accepted" | "rejected" | "unreachable";
  detail: string;
};

/** Combine the local shape with Cloudflare's own verify answer. */
export function tokenVerdict(
  shape: { state: TokenShape; detail: string },
  remote: { ok: boolean; status: number } | null,
): TokenVerdict {
  if (shape.state !== "present") return { state: shape.state, detail: shape.detail };
  if (!remote) {
    return {
      state: "unreachable",
      detail:
        "Cloudflare could not be asked whether the token is valid. The value was not recorded.",
    };
  }
  if (remote.ok) {
    return {
      state: "accepted",
      detail: "Cloudflare accepted the token. The value was not recorded.",
    };
  }
  return {
    state: "rejected",
    detail: `Cloudflare rejected the token (${remote.status}). Create a dashboard API token and set it on the host. The value was not recorded.`,
  };
}
