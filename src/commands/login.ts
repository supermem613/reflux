import chalk from "chalk";
import { isAuthenticated, isInstalled, loginInteractive } from "../auth/gh.js";
import { loadConfig } from "../core/config.js";
import { getProfile } from "../core/profiles.js";
import { RefluxError } from "../core/types.js";

/**
 * `reflux login <profile>` — drives `gh auth login` for the profile's gh
 * user. If gh already has that user authenticated, this is a no-op (we
 * print a friendly "already signed in" and exit).
 *
 * gh handles the actual sign-in with its own device-flow dance (browser +
 * 8-character code). We inherit stdio so the user sees gh's prompts.
 */
export async function loginCommand(profileName: string): Promise<void> {
  const config = loadConfig();
  const profile = getProfile(profileName, config);
  if (!profile) {
    throw new RefluxError(
      `Profile '${profileName}' does not exist. Create it with \`reflux profile add ${profileName} --gh-user <login>\`.`,
    );
  }
  if (!isInstalled()) {
    throw new RefluxError(
      "gh CLI not found on PATH. Install from https://cli.github.com and retry.",
    );
  }

  if (isAuthenticated(profile.ghUser)) {
    console.log(chalk.green("✓") + ` gh already signed in as ${chalk.cyan(profile.ghUser)}.`);
    console.log(chalk.dim("  Nothing to do. (Use `gh auth logout --user " + profile.ghUser + "` to force a fresh login.)"));
    return;
  }

  console.log(chalk.dim(`Launching \`gh auth login\` for profile ${chalk.cyan(profileName)} (gh user ${chalk.cyan(profile.ghUser)}).`));
  console.log(chalk.dim("A browser will open with an 8-character device code. Pick the matching GitHub account when gh asks."));

  const code = await loginInteractive();
  if (code !== 0) {
    throw new RefluxError(`gh auth login exited with code ${code}.`);
  }

  if (!isAuthenticated(profile.ghUser)) {
    console.log(
      chalk.yellow("⚠") +
      ` gh login completed but no account named '${profile.ghUser}' is reported by \`gh auth status\`.`,
    );
    console.log(chalk.dim("  Did you sign in as a different account? Update the profile with the correct --gh-user."));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.green("✓") + ` Signed in as ${chalk.cyan(profile.ghUser)}.`);
}
