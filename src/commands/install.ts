import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";

const execFileAsync = promisify(execFile);

/**
 * `reflux install` — register git-credential-reflux as the only helper for
 * github.com URLs. Reflux itself passes through to GCM for unmapped URLs
 * and on gh-token failures, so the user gets the union of behaviours.
 *
 *   git config --global --add credential.https://github.com.helper ""
 *   git config --global --add credential.https://github.com.helper reflux
 *
 * The empty-string entry clears any inherited helper (GCM via the global
 * credential.helper) so reflux runs first. Reflux's helper handles the
 * fallback to GCM internally on routing miss / gh failure.
 *
 * `reflux uninstall` removes BOTH the reflux entry and the reset entry,
 * restoring the user's pre-install state. Leaving the reset behind would
 * silently keep github.com auth broken.
 */

const URL_SCOPE = "credential.https://github.com";
const HELPER_KEY = `${URL_SCOPE}.helper`;

async function gitConfig(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["config", "--global", ...args]);
  return stdout;
}

async function ensureHelperRegistered(): Promise<void> {
  let existing = "";
  try {
    const { stdout } = await execFileAsync("git", [
      "config", "--global", "--get-all", HELPER_KEY,
    ]);
    existing = stdout;
  } catch {
    // git config --get-all exits 1 when the key has no values; treat as empty.
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((line) => line.trim() === "reflux")) {
    return; // already registered
  }
  if (!lines.some((line) => line === "")) {
    await gitConfig(["--add", HELPER_KEY, ""]);
  }
  await gitConfig(["--add", HELPER_KEY, "reflux"]);
}

export async function installCommand(): Promise<void> {
  await ensureHelperRegistered();
  console.log(chalk.green("✓") + ` Registered git-credential-reflux for ${chalk.cyan("https://github.com")}`);
  console.log(chalk.dim("\nNext steps:"));
  console.log(chalk.dim("  reflux profile add <name> --gh-user <login>"));
  console.log(chalk.dim("  reflux login <name>"));
  console.log(chalk.dim("  reflux map add <url-prefix> <name>"));
}

async function tryUnset(valuePattern: string): Promise<boolean> {
  try {
    await execFileAsync("git", [
      "config", "--global", "--unset-all", HELPER_KEY, valuePattern,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function uninstallCommand(): Promise<void> {
  // Remove both the reflux entry and the empty-string reset entry that
  // install() added. Leaving the reset behind keeps github.com auth
  // broken for users who relied on a global GCM helper.
  const removedReflux = await tryUnset("^reflux$");
  const removedReset = await tryUnset("^$");
  if (removedReflux || removedReset) {
    console.log(chalk.green("✓") + " Removed git-credential-reflux from git config");
  } else {
    console.log(chalk.dim("git-credential-reflux was not registered."));
  }
  console.log(chalk.dim("\nProfiles and mappings in ~/.reflux/config.json were left alone."));
  console.log(chalk.dim("`gh` accounts were left alone. Use `gh auth logout` to clear them."));
}
