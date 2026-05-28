/**
 * Decide whether a credential request should be served by reflux's own OAuth
 * machinery or passed through to vanilla git-credential-manager.
 *
 * Reflux owns github.com. Anything else passes through. Unmapped github.com
 * requests are returned as explicit decisions so the helper can auto-learn or
 * fail loud without falling through to GCM.
 */

import { Config } from "../core/config.js";
import { resolveProfileFromCredentialRequest } from "../core/mapping.js";
import { CredentialRequest } from "./protocol.js";

export type RouteDecision =
  | { kind: "reflux"; profile: string }
  | { kind: "unmapped-github"; owner?: string; reason: string }
  | { kind: "passthrough"; reason: string };

const REFLUX_OWNED_HOSTS = new Set(["github.com"]);

export function routeRequest(req: CredentialRequest, config: Config): RouteDecision {
  const host = req.host?.toLowerCase();
  if (!host) {
    return { kind: "passthrough", reason: "no host on request" };
  }
  if (!REFLUX_OWNED_HOSTS.has(host)) {
    return { kind: "passthrough", reason: `host '${host}' not in reflux scope` };
  }

  const profile = resolveProfileFromCredentialRequest(req, config);
  if (!profile) {
    return {
      kind: "unmapped-github",
      owner: githubOwnerFromPath(req.path),
      reason: `no mapping for ${host}/${req.path ?? ""}`,
    };
  }
  return { kind: "reflux", profile };
}

export function githubOwnerFromPath(path: string | undefined): string | undefined {
  const owner = path?.split(/[\\/]/)[0]?.trim();
  return owner || undefined;
}
