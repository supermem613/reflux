/**
 * File-and-stderr logger for reflux.
 *
 * The git credential helper protocol owns stdout — anything written there is
 * parsed by git as credentials. So this logger writes to a file always
 * (%LOCALAPPDATA%\reflux\logs\reflux.log) and mirrors to stderr only when
 * REFLUX_DEBUG=1 is set. CLI commands can also write to stdout directly with
 * chalk; this logger is for diagnostics.
 *
 * The log is line-buffered, never the bottleneck on a credential lookup, and
 * append-only. No rotation today — if it grows large enough to matter,
 * rotation can ship later behind the same API.
 */

import { appendFileSync } from "node:fs";
import { ensureDir, logFile, logsDir } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function debugEnabled(): boolean {
  return process.env.REFLUX_DEBUG === "1";
}

function format(level: LogLevel, scope: string, message: string, extras?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const pid = process.pid;
  const extra = extras && Object.keys(extras).length > 0
    ? " " + JSON.stringify(extras)
    : "";
  return `${ts} pid=${pid} ${level.toUpperCase()} [${scope}] ${message}${extra}\n`;
}

function emit(level: LogLevel, scope: string, message: string, extras?: Record<string, unknown>): void {
  const line = format(level, scope, message, extras);

  try {
    ensureDir(logsDir());
    appendFileSync(logFile(), line, "utf-8");
  } catch {
    // Logging must never throw — if we can't write the log file, we silently
    // continue. The helper protocol is more important than diagnostics.
  }

  if (debugEnabled() && LEVEL_RANK[level] >= LEVEL_RANK.debug) {
    process.stderr.write(line);
  } else if (LEVEL_RANK[level] >= LEVEL_RANK.warn) {
    // warn/error always mirror to stderr so failed credential lookups are
    // visible to the user even without REFLUX_DEBUG.
    process.stderr.write(line);
  }
}

/** Create a logger scoped to a specific module (e.g. "helper", "github-oauth"). */
export function createLogger(scope: string): {
  debug: (message: string, extras?: Record<string, unknown>) => void;
  info: (message: string, extras?: Record<string, unknown>) => void;
  warn: (message: string, extras?: Record<string, unknown>) => void;
  error: (message: string, extras?: Record<string, unknown>) => void;
} {
  return {
    debug: (msg, extras) => emit("debug", scope, msg, extras),
    info: (msg, extras) => emit("info", scope, msg, extras),
    warn: (msg, extras) => emit("warn", scope, msg, extras),
    error: (msg, extras) => emit("error", scope, msg, extras),
  };
}
