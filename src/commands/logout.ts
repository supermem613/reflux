import chalk from "chalk";
import { isAuthenticated, isInstalled, logout } from "../auth/gh.js";
import { loadConfig } from "../core/config.js";
import { getProfile } from "../core/profiles.js";
import { RefluxError } from "../core/types.js";

/**
 * `reflux logout <profile>` — runs `gh auth logout --user <ghUser>` for the
 * profile. Best-effort: if gh isn't holding that account, this is a no-op.
 */
export function logoutCommand(profileName: string): void {
  const config = loadConfig();
  const profile = getProfile(profileName, config);
  if (!profile) {
    throw new RefluxError(`Profile '${profileName}' does not exist.`);
  }
  if (!isInstalled()) {
    throw new RefluxError("gh CLI not found on PATH.");
  }

  if (!isAuthenticated(profile.ghUser)) {
    console.log(chalk.dim(`gh has no session for ${profile.ghUser}. Nothing to do.`));
    return;
  }

  const result = logout(profile.ghUser);
  if (!result.ok) {
    throw new RefluxError(`gh auth logout failed: ${result.reason ?? "unknown error"}`);
  }
  console.log(chalk.green("✓") + ` Logged out ${chalk.cyan(profile.ghUser)}.`);
}
