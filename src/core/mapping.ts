/**
 * Remote-URL → profile resolution.
 *
 * Routing happens per remote URL, not per repo. That matters for repos like
 * `~/repos/dotfiles` whose `origin` is personal but whose `work` remote is
 * the work fork — each git push hits the helper with a different URL, and
 * each must resolve to the right identity.
 *
 * Match algorithm: longest-prefix wins, after URL normalisation. Normalised
 * form is `https://<lowercase-host>/<path>` with any `.git` suffix stripped
 * and `git@host:owner/repo` rewritten to `https://host/owner/repo`. This
 * means a single mapping like `https://github.com/microsoft/` covers both
 * `https://github.com/microsoft/foo.git` and `git@github.com:microsoft/foo`.
 */

import { Config, loadConfig } from "./config.js";

/**
 * Normalise a git remote URL into `https://<host>/<path>` lower-case-host
 * form, with `.git` suffix removed and trailing slashes preserved on path.
 *
 * Inputs we expect to handle:
 *   https://github.com/foo/bar.git
 *   https://GITHUB.COM/foo/bar/
 *   git@github.com:foo/bar.git
 *   ssh://git@github.com/foo/bar.git
 *   github.com/foo/bar           (just in case)
 */
export function normalizeRemoteUrl(input: string): string {
  let url = input.trim();
  if (!url) {
    return "";
  }

  // git@host:owner/repo  →  https://host/owner/repo
  const sshShort = url.match(/^(?:[^@\s]+@)([^:/\s]+):(.+)$/);
  if (sshShort) {
    url = `https://${sshShort[1]}/${sshShort[2]}`;
  }

  // ssh://git@host/owner/repo  →  https://host/owner/repo
  if (url.startsWith("ssh://")) {
    url = url.replace(/^ssh:\/\/(?:[^@/]+@)?/, "https://");
  }

  // bare host/path  →  https://host/path
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }

  const host = parsed.host.toLowerCase();
  let path = parsed.pathname.replace(/\.git$/i, "");
  // Drop double slashes that a stray input may have introduced.
  path = path.replace(/\/+/g, "/");
  // We want to preserve a trailing slash if the user supplied one, because
  // prefix mappings often end in /.
  return `https://${host}${path}`;
}

/**
 * Resolve a remote URL to a profile name, or null if no mapping matches.
 * Longest matching prefix wins. Ties (same length) prefer the mapping
 * declared earlier in the config — but the schema disallows duplicates, so
 * ties are not expected in practice.
 */
export function resolveProfile(
  remoteUrl: string,
  config: Config = loadConfig(),
): string | null {
  const normalized = normalizeRemoteUrl(remoteUrl);
  if (!normalized) {
    return null;
  }

  let bestPrefixLen = -1;
  let bestProfile: string | null = null;

  for (const mapping of config.mappings) {
    const prefix = normalizeRemoteUrl(mapping.prefix);
    if (!prefix) {
      continue;
    }
    if (normalized.startsWith(prefix) && prefix.length > bestPrefixLen) {
      bestPrefixLen = prefix.length;
      bestProfile = mapping.profile;
    }
  }
  return bestProfile;
}

/**
 * Resolve from the (host, protocol, path) tuple that the git credential
 * helper protocol supplies on stdin. Reconstructs a URL and dispatches to
 * resolveProfile.
 */
export function resolveProfileFromCredentialRequest(
  request: { protocol?: string; host?: string; path?: string },
  config: Config = loadConfig(),
): string | null {
  const proto = request.protocol ?? "https";
  const host = request.host;
  if (!host) {
    return null;
  }
  const path = request.path ?? "";
  const url = `${proto}://${host}/${path}`.replace(/\/+$/, "");
  return resolveProfile(url, config);
}
