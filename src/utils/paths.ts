/**
 * Filesystem path resolvers for reflux.
 *
 * Reflux's only on-disk state is:
 *   ~/.reflux/config.json    profiles + URL → profile mappings
 *   %LOCALAPPDATA%\reflux\logs\reflux.log    helper + CLI log
 *
 * Tokens are owned by `gh`'s own keyring; reflux never persists them.
 *
 * Config lives in homedir (not LOCALAPPDATA) so the user can hand-edit and
 * back it up alongside other dotfiles.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function localAppData(): string {
  // LOCALAPPDATA is set in tests via the run.mjs sandbox; fall back to the
  // standard Windows location if it's missing entirely.
  return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
}

export function refluxRoot(): string {
  return join(localAppData(), "reflux");
}

export function logsDir(): string {
  return join(refluxRoot(), "logs");
}

export function logFile(): string {
  return join(logsDir(), "reflux.log");
}

export function configDir(): string {
  return join(homedir(), ".reflux");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Ensure a directory exists. Idempotent; safe to call repeatedly. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
