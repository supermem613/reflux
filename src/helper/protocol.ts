/**
 * Git credential helper protocol.
 *
 * Spec:
 *   https://git-scm.com/docs/git-credential#IOFMT
 *
 * Wire format on stdin and stdout: a sequence of `key=value\n` lines
 * terminated by a single empty line. Keys git sends are: protocol, host,
 * path, username, password, url, capability[]. Helpers reply with the same
 * keys (typically just username + password) terminated by a blank line.
 *
 * Helpers are invoked by git as `git-credential-<name> <action>` where
 * action ∈ {get, store, erase}. Parsing the action is the caller's job;
 * this module only handles the kv-stream.
 */

import { Readable } from "node:stream";

export type CredentialAction = "get" | "store" | "erase";

export interface CredentialRequest {
  protocol?: string;
  host?: string;
  path?: string;
  username?: string;
  password?: string;
  url?: string;
  /** capability[] line — git sends one per supported capability. */
  capabilities?: string[];
  /** Anything else git sends that we don't model explicitly. */
  extras?: Record<string, string>;
}

export interface CredentialResponse {
  username?: string;
  password?: string;
  /** Optional explicit expiry (ISO timestamp). Recent gits use this. */
  password_expiry_utc?: string;
  /** Unknown keys to forward verbatim (e.g. when proxying GCM). */
  extras?: Record<string, string>;
}

const KNOWN_KEYS = new Set([
  "protocol", "host", "path", "username", "password", "url",
]);

export function parseCredentialStream(input: string): CredentialRequest {
  const req: CredentialRequest = { capabilities: [], extras: {} };
  for (const rawLine of input.split(/\r?\n/)) {
    if (rawLine === "") break; // blank line terminates the request
    const eq = rawLine.indexOf("=");
    if (eq < 0) continue;
    const key = rawLine.slice(0, eq);
    const value = rawLine.slice(eq + 1);
    if (key === "capability[]") {
      req.capabilities!.push(value);
    } else if (KNOWN_KEYS.has(key)) {
      (req as Record<string, string | undefined>)[key] = value;
    } else {
      req.extras![key] = value;
    }
  }
  if (req.capabilities!.length === 0) delete req.capabilities;
  if (Object.keys(req.extras!).length === 0) delete req.extras;
  return req;
}

export function formatCredentialStream(response: CredentialResponse): string {
  const lines: string[] = [];
  if (response.username !== undefined) lines.push(`username=${response.username}`);
  if (response.password !== undefined) lines.push(`password=${response.password}`);
  if (response.password_expiry_utc !== undefined) {
    lines.push(`password_expiry_utc=${response.password_expiry_utc}`);
  }
  if (response.extras) {
    for (const [k, v] of Object.entries(response.extras)) {
      lines.push(`${k}=${v}`);
    }
  }
  // Trailing blank line terminates the response per the protocol.
  return lines.join("\n") + "\n\n";
}

/**
 * Read all of stdin into a string. Helper protocol payloads are tiny
 * (< 1KB), so this is fine.
 */
export async function readStdin(stream: Readable = process.stdin): Promise<string> {
  // process.stdin has isTTY; arbitrary Readable streams don't. If we're
  // attached to a TTY (no input piped) there's nothing to read.
  if ((stream as Readable & { isTTY?: boolean }).isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Compute a stable "remote URL" for a credential request, used both for
 * mapping resolution and for logging. Prefers the explicit url field when
 * git supplies one, otherwise reconstructs from protocol+host+path.
 */
export function requestUrl(req: CredentialRequest): string {
  if (req.url) return req.url;
  const proto = req.protocol ?? "https";
  const host = req.host ?? "";
  const path = req.path ?? "";
  return `${proto}://${host}/${path}`.replace(/\/+$/, "");
}
