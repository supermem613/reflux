#!/usr/bin/env node
/**
 * git-credential-reflux — git credential helper protocol entry point.
 *
 * Invoked by git as `git-credential-reflux <action>` where action is
 * get | store | erase.
 *
 *   get   — read a CredentialRequest from stdin and emit a
 *           CredentialResponse on stdout. Hot path.
 *   store — git is confirming the credential we just supplied. For reflux-
 *           owned hosts there's nothing to do (the live token is owned by
 *           `gh`, not by us). For passthrough hosts, forward to GCM.
 *   erase — git is telling us the credential we supplied was rejected. For
 *           reflux-owned hosts we just log and exit 0 — `gh` owns the
 *           token lifecycle and the user is the right party to re-auth via
 *           `reflux login <profile>`. For passthrough hosts, forward to GCM.
 *
 * stdout is reserved for the protocol — diagnostics go to the log file
 * (and to stderr only when REFLUX_DEBUG=1).
 */

import { loadConfig } from "./core/config.js";
import { getProfile } from "./core/profiles.js";
import { getToken } from "./auth/gh.js";
import {
  CredentialAction,
  CredentialRequest,
  formatCredentialStream,
  parseCredentialStream,
  readStdin,
  requestUrl,
} from "./helper/protocol.js";
import { passthroughToGcm } from "./helper/passthrough.js";
import { routeRequest } from "./helper/route.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("helper");

function isCredentialAction(value: string | undefined): value is CredentialAction {
  return value === "get" || value === "store" || value === "erase";
}

async function handleGet(request: CredentialRequest, stdinBuffer: string): Promise<number> {
  const config = loadConfig();
  const decision = routeRequest(request, config);

  if (decision.kind === "passthrough") {
    log.debug("passthrough", { url: requestUrl(request), reason: decision.reason });
    const { exitCode } = await passthroughToGcm("get", { stdinBuffer });
    return exitCode;
  }

  const profileName = decision.profile;
  const profile = getProfile(profileName, config);
  if (!profile) {
    // Routing decided this is reflux's, but the profile vanished between the
    // mapping read and the lookup. Treat as no-op so the next helper tries.
    log.warn("routed profile missing in config", { profile: profileName });
    return 0;
  }

  log.debug("reflux-owned", { url: requestUrl(request), profile: profileName, ghUser: profile.ghUser });

  const result = getToken(profile.ghUser, request.host ?? "github.com");
  if (!result.ok) {
    // gh has no live token for this user. We cannot fall through via the
    // helper chain — `reflux install` resets the chain so reflux is the
    // only registered helper for github.com. Spawn GCM directly so the
    // user gets the prompt they would have gotten without reflux.
    log.warn("gh auth token failed; passing through to GCM", {
      profile: profileName,
      ghUser: profile.ghUser,
      reason: result.reason,
    });
    const { exitCode } = await passthroughToGcm("get", { stdinBuffer });
    return exitCode;
  }

  const response = formatCredentialStream({
    username: profile.ghUser,
    password: result.token,
  });
  process.stdout.write(response);
  return 0;
}

async function handleStore(request: CredentialRequest, stdinBuffer: string): Promise<number> {
  const config = loadConfig();
  const decision = routeRequest(request, config);
  if (decision.kind === "passthrough") {
    const { exitCode } = await passthroughToGcm("store", { stdinBuffer });
    return exitCode;
  }
  // gh owns the token lifecycle; nothing to record.
  return 0;
}

async function handleErase(request: CredentialRequest, stdinBuffer: string): Promise<number> {
  const config = loadConfig();
  const decision = routeRequest(request, config);
  if (decision.kind === "passthrough") {
    const { exitCode } = await passthroughToGcm("erase", { stdinBuffer });
    return exitCode;
  }
  // The user asked git to forget the credential we served. We don't touch
  // gh's keyring — that would log out other tools (`gh repo clone`, gh's
  // own git-credential helper) the user did not authorise us to disturb.
  // The right recovery is `reflux login <profile>` (or `gh auth login`).
  log.warn("erase: ignoring; run `reflux login <profile>` to re-auth", {
    profile: decision.profile,
  });
  return 0;
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (!isCredentialAction(action)) {
    process.stderr.write(
      "git-credential-reflux: expected one of {get, store, erase} as first argument.\n",
    );
    process.exit(2);
  }

  const stdinBuffer = await readStdin();
  const request = parseCredentialStream(stdinBuffer);

  try {
    let exitCode = 0;
    switch (action) {
      case "get":
        exitCode = await handleGet(request, stdinBuffer);
        break;
      case "store":
        exitCode = await handleStore(request, stdinBuffer);
        break;
      case "erase":
        exitCode = await handleErase(request, stdinBuffer);
        break;
    }
    process.exit(exitCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${action} failed`, { error: msg });
    process.stderr.write(`reflux: ${msg}\n`);
    // Exit non-zero so git falls through to the next configured helper.
    process.exit(1);
  }
}

main();
