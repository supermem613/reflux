/**
 * Decide whether a credential request should be served by reflux's own OAuth
 * machinery or passed through to vanilla git-credential-manager.
 *
 * v0.1.0 scope: reflux owns github.com only. Anything else passes through.
 * For github.com, reflux owns the request only if a mapping resolves it to
 * a known profile; otherwise it passes through (so unmapped GitHub repos
 * keep working with whatever GCM has cached).
 */

import { Config } from "../core/config.js";
import { resolveProfileFromCredentialRequest } from "../core/mapping.js";
import { CredentialRequest } from "./protocol.js";

export type RouteDecision =
  | { kind: "reflux"; profile: string }
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
    return { kind: "passthrough", reason: `no mapping for ${host}/${req.path ?? ""}` };
  }
  return { kind: "reflux", profile };
}
