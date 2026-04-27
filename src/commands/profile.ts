import chalk from "chalk";
import { isInstalled, isAuthenticated, authStatus } from "../auth/gh.js";
import { addProfile, listProfiles, removeProfile } from "../core/profiles.js";
import { Profile, RefluxError } from "../core/types.js";

interface ProfileAddOptions {
  ghUser: string;
}

export function profileAddCommand(name: string, options: ProfileAddOptions): void {
  if (!options.ghUser) {
    throw new RefluxError("`--gh-user <login>` is required.");
  }
  const profile: Profile = { name, ghUser: options.ghUser };
  addProfile(profile);
  console.log(chalk.green("✓") + ` Added profile ${chalk.cyan(name)} → gh user ${chalk.cyan(options.ghUser)}`);

  if (!isInstalled()) {
    console.log(chalk.yellow("⚠") + " gh CLI not found on PATH. Install from https://cli.github.com.");
    return;
  }
  if (!isAuthenticated(options.ghUser)) {
    console.log(chalk.dim(`  gh is not signed in as ${options.ghUser} yet.`));
    console.log(chalk.dim(`  Next: \`reflux login ${name}\``));
  } else {
    console.log(chalk.dim(`  gh already has ${options.ghUser} authenticated. You're good.`));
  }
}

export function profileListCommand(): void {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log(chalk.dim("(no profiles)"));
    console.log(chalk.dim("  Create one with `reflux profile add <name> --gh-user <login>`."));
    return;
  }
  const ghReady = isInstalled();
  // Snapshot gh accounts once instead of spawning `gh auth status` per profile.
  const ghUsers = ghReady ? new Set(authStatus().map((a) => a.user)) : new Set<string>();
  for (const p of profiles) {
    const authed = ghUsers.has(p.ghUser);
    const dot = authed ? chalk.green("●") : chalk.yellow("○");
    console.log(`${dot} ${chalk.cyan(p.name.padEnd(16))} → ${chalk.cyan(p.ghUser)}${authed ? "" : chalk.dim("  (not signed in)")}`);
  }
}

export function profileRemoveCommand(name: string): void {
  removeProfile(name);
  console.log(chalk.green("✓") + ` Removed profile ${chalk.cyan(name)}`);
  console.log(chalk.dim("  gh credentials were left alone. Use `gh auth logout --user <login>` to clear them."));
}

export function profileShowCommand(name: string): void {
  const profile = listProfiles().find((p) => p.name === name);
  if (!profile) {
    throw new RefluxError(`Profile '${name}' does not exist.`);
  }
  console.log(chalk.cyan(profile.name));
  console.log(`  gh user:        ${profile.ghUser}`);
  if (isInstalled()) {
    console.log(`  gh signed in:   ${isAuthenticated(profile.ghUser) ? "yes" : chalk.yellow("no — run `reflux login " + name + "`")}`);
  } else {
    console.log(`  gh signed in:   ${chalk.yellow("unknown — gh CLI not found on PATH")}`);
  }
}
