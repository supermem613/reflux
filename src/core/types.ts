/**
 * Shared types for reflux.
 *
 * (contract — change with care)
 */

export class RefluxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RefluxError";
  }
}

/**
 * Identity profile — one per GitHub account the user holds.
 *
 * `name` is the user-facing alias (e.g. "work", "personal") and shows up in
 * git authentication logs as the username on each request reflux serves.
 *
 * `ghUser` is the GitHub login that `gh auth status` reports for that
 * identity. Reflux calls `gh auth token --user <ghUser>` to fetch the live
 * token at credential-helper time.
 */
export interface Profile {
  /** User-chosen identifier. Must match /^[a-z0-9][a-z0-9-]*$/. */
  name: string;
  /** GitHub login this profile resolves to (e.g. "supermem613"). */
  ghUser: string;
}

/** Mapping from a remote-URL prefix to a profile name. */
export interface Mapping {
  /**
   * URL prefix to match. Longest-prefix wins after URL normalisation
   * (see core/mapping.ts). Examples:
   *   "https://github.com/microsoft/"      → all microsoft org repos
   *   "https://github.com/personal-user/"  → only one user's repos
   *   "https://github.com/"                → catch-all
   */
  prefix: string;
  /** Profile name this prefix routes to. Must exist in profiles[]. */
  profile: string;
}
