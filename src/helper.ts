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

import chalk from "chalk";
import { loadConfig } from "./core/config.js";
import { getProfile } from "./core/profiles.js";
import { getToken, isAuthenticated, isInstalled as isGhInstalled, loginInteractive } from "./auth/gh.js";
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

  let result = getToken(profile.ghUser, request.host ?? "github.com");
  if (!result.ok) {
    // gh has no live token for this user. We KNOW which profile and which
    // gh user are required (the mapping resolved cleanly), so the right
    // recovery is to drive `gh auth login` ourselves — silently falling
    // through to GCM would prompt for username/password and leave the
    // user without a working token even on success.
    //
    // This is an *expected* recovery path, not a fault: log at info so the
    // file record exists but the user does not see a noisy WARN line above
    // the formatted banner.
    log.info("driving gh auth login for missing token", {
      profile: profileName,
      ghUser: profile.ghUser,
      reason: result.reason,
    });
    if (!isGhInstalled()) {
      writeStatus("error", `gh CLI is not installed.`, [
        `Profile ${chalk.cyan(profileName)} requires gh user ${chalk.cyan(profile.ghUser)}.`,
        `Install gh from https://cli.github.com and retry.`,
      ]);
      // Tell git to stop the helper chain instead of falling through to a
      // built-in prompt that cannot produce a usable token here.
      process.stdout.write("quit=1\n\n");
      return 0;
    }

    if (process.env.REFLUX_NO_AUTO_LOGIN === "1") {
      writeStatus("warn", `Auto-login disabled by REFLUX_NO_AUTO_LOGIN=1.`, [
        `Run \`reflux login ${profileName}\` and retry.`,
      ]);
      process.stdout.write("quit=1\n\n");
      return 0;
    }

    writeStatus(
      "warn",
      `Profile ${chalk.cyan(profileName)} (gh user ${chalk.cyan(profile.ghUser)}) is not signed in.`,
      [
        `Launching \`gh auth login\` — sign in as ${chalk.cyan(profile.ghUser)} when the browser opens.`,
        `(set REFLUX_NO_AUTO_LOGIN=1 to disable this and fall back to a hard error.)`,
      ],
    );

    const loginExit = await loginInteractive([], { quietStdout: true });
    if (loginExit !== 0) {
      writeStatus("error", `gh auth login exited ${loginExit}.`, [
        `Run \`reflux login ${profileName}\` manually and retry.`,
      ]);
      process.stdout.write("quit=1\n\n");
      return 0;
    }

    // Verify the user signed in as the expected account, not some other
    // GitHub identity that happened to be in their browser.
    if (!isAuthenticated(profile.ghUser)) {
      writeStatus(
        "error",
        `gh login completed, but no account named ${chalk.cyan(profile.ghUser)} is reported by \`gh auth status\`.`,
        [
          `Did you sign in as a different account?`,
          `Update the profile: \`reflux profile add ${profileName} --gh-user <correct-user>\``,
          `Or re-run \`gh auth login\` and pick the right account.`,
        ],
      );
      process.stdout.write("quit=1\n\n");
      return 0;
    }

    result = getToken(profile.ghUser, request.host ?? "github.com");
    if (!result.ok) {
      writeStatus("error", `Still no token for ${chalk.cyan(profile.ghUser)} after login.`, [
        `Reason: ${result.reason}`,
        `Run \`reflux doctor\` to inspect gh + reflux state.`,
      ]);
      process.stdout.write("quit=1\n\n");
      return 0;
    }

    writeStatus("ok", `Signed in as ${chalk.cyan(profile.ghUser)}.`, [`Serving credential to git.`]);
  }

  const response = formatCredentialStream({
    username: profile.ghUser,
    password: result.token,
  });
  process.stdout.write(response);
  return 0;
}

/**
 * Write a CLI-styled status block to stderr.
 *
 * Stdout is reserved for git's credential protocol, so all user-visible
 * output goes to stderr. The format mirrors the rest of the reflux CLI
 * (`install`, `update`, `profile`, etc.):
 *
 *   <blank>
 *     <icon> <headline>
 *           <hint line 1>
 *           <hint line 2>
 *   <blank>
 *
 * Icons match doctor/install: green ✓, yellow ⚠, red ✗.
 */
function writeStatus(kind: "ok" | "warn" | "error", headline: string, hints: string[] = []): void {
  const icon =
    kind === "ok" ? chalk.green("✓") :
    kind === "error" ? chalk.red("✗") :
    chalk.yellow("⚠");
  const lines: string[] = ["", `  ${icon} ${headline}`];
  for (const h of hints) {
    lines.push(`    ${chalk.dim(h)}`);
  }
  lines.push("");
  process.stderr.write(lines.join("\n"));
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
