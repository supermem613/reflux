/**
 * Wrapper around the `gh` CLI.
 *
 * Reflux delegates all GitHub authentication state to `gh` — it stores
 * tokens in Windows Credential Manager under its own keys, manages multiple
 * accounts, and exposes a stable `gh auth token --user <login>` interface
 * for retrieval. This module is the only place reflux shells out to it.
 *
 * The binary name is overridable via the REFLUX_GH_BIN environment variable
 * (used by tests to inject a stub).
 */

import { spawn, spawnSync } from "node:child_process";

const GH_BIN = (): string => process.env.REFLUX_GH_BIN ?? "gh";

// Windows blocks direct spawn of .cmd / .bat since the Node 20.12 CVE fix.
// Production gh is "gh" or "gh.exe" — this only flips on for test shims.
const needsShell = (bin: string): boolean => /\.(cmd|bat)$/i.test(bin);

export interface GhAccount {
  user: string;
  hostname: string;
  active: boolean;
}

export type GhTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: string };

/** True if `gh` is callable on PATH. */
export function isInstalled(): boolean {
  try {
    const r = spawnSync(GH_BIN(), ["--version"], { encoding: "utf-8", windowsHide: true, shell: needsShell(GH_BIN()) });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Return the current OAuth token for a specific gh account.
 *
 * Maps cleanly onto `gh auth token --hostname <h> --user <u>`. Returns the
 * token on success; on failure returns a structured reason rather than
 * throwing (callers in the helper hot path want to fall through to the next
 * git credential helper, not crash).
 */
export function getToken(ghUser: string, hostname = "github.com"): GhTokenResult {
  let r;
  try {
    r = spawnSync(
      GH_BIN(),
      ["auth", "token", "--hostname", hostname, "--user", ghUser],
      { encoding: "utf-8", windowsHide: true, shell: needsShell(GH_BIN()) },
    );
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (r.error) {
    return { ok: false, reason: r.error.message };
  }
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    return { ok: false, reason: stderr || `gh auth token exited ${r.status}` };
  }
  const token = (r.stdout ?? "").trim();
  if (!token) {
    return { ok: false, reason: "gh auth token returned empty output" };
  }
  return { ok: true, token };
}

/**
 * Parse `gh auth status` for the given hostname into a list of accounts.
 *
 * `gh` historically wrote status to stderr; we read both streams and parse
 * the lines `account <login>` and the following `Active account: true`
 * marker. Output format may shift across gh versions, so this is forgiving:
 * unknown lines are ignored.
 */
export function authStatus(hostname = "github.com"): GhAccount[] {
  let r;
  try {
    r = spawnSync(
      GH_BIN(),
      ["auth", "status", "--hostname", hostname],
      { encoding: "utf-8", windowsHide: true, shell: needsShell(GH_BIN()) },
    );
  } catch {
    return [];
  }
  if (r.error) return [];
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const accounts: GhAccount[] = [];
  let current: GhAccount | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/account\s+([A-Za-z0-9][A-Za-z0-9_-]*)/);
    if (m) {
      current = { user: m[1], hostname, active: false };
      accounts.push(current);
      continue;
    }
    if (current && /^- Active account:\s*true/i.test(line)) {
      current.active = true;
    }
  }
  return accounts;
}

/** True if the given gh user appears in `gh auth status`. */
export function isAuthenticated(ghUser: string, hostname = "github.com"): boolean {
  return authStatus(hostname).some((a) => a.user === ghUser);
}

/**
 * Run `gh auth login` for github.com via the web/device flow.
 *
 * gh asks one interactive question we always want to answer the same way:
 *   "Authenticate Git with your GitHub credentials? (Y/n)"
 * Answering "y" would set gh up as the git credential helper — but reflux
 * IS the helper, and letting gh register itself would shadow reflux for
 * github.com. So we pre-write "n\n" to gh's stdin and let gh handle the
 * rest (device code display, browser open, polling).
 *
 * stdout normally inherits so the user sees the device code. When called
 * from the credential-helper subprocess, the parent's stdout is git's
 * protocol pipe — emitting a device code there would corrupt the
 * response. Pass `quietStdout: true` to redirect gh's stdout to stderr so
 * the user still sees it but git's pipe stays clean.
 */
export interface LoginInteractiveOptions {
  /** Redirect gh's stdout to stderr. Required when invoking from the helper. */
  quietStdout?: boolean;
}

export function loginInteractive(
  extraArgs: string[] = [],
  opts: LoginInteractiveOptions = {},
): Promise<number> {
  return new Promise<number>((resolve) => {
    const stdout = opts.quietStdout ? "pipe" : "inherit";
    const child = spawn(
      GH_BIN(),
      ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", ...extraArgs],
      { stdio: ["pipe", stdout, "inherit"], windowsHide: false, shell: needsShell(GH_BIN()) },
    );
    if (opts.quietStdout && child.stdout) {
      // Mirror gh's stdout into our stderr so the user sees the device code
      // and any progress lines without polluting git's protocol pipe.
      child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    }
    // Decline the "Authenticate Git with your GitHub credentials?" prompt.
    // Writing more than one line is harmless if gh asks fewer questions.
    if (child.stdin) {
      child.stdin.write("n\n");
      child.stdin.end();
    }
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/**
 * Log a specific gh account out. Best-effort; returns the structured result
 * so callers can decide whether a missing account should be a hard error.
 */
export function logout(ghUser: string, hostname = "github.com"): { ok: boolean; reason?: string } {
  let r;
  try {
    r = spawnSync(
      GH_BIN(),
      ["auth", "logout", "--hostname", hostname, "--user", ghUser],
      { encoding: "utf-8", windowsHide: true, shell: needsShell(GH_BIN()) },
    );
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").trim();
    return { ok: false, reason: stderr || `gh auth logout exited ${r.status}` };
  }
  return { ok: true };
}

/** `gh --version` first line, or null if gh is missing. */
export function version(): string | null {
  try {
    const r = spawnSync(GH_BIN(), ["--version"], { encoding: "utf-8", windowsHide: true, shell: needsShell(GH_BIN()) });
    if (r.status !== 0) return null;
    return (r.stdout ?? "").split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}
