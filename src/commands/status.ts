import chalk from "chalk";
import { authStatus, isInstalled, version as ghVersion } from "../auth/gh.js";
import { loadConfig } from "../core/config.js";

export function statusCommand(): void {
  const config = loadConfig();

  console.log(chalk.bold("gh CLI"));
  if (!isInstalled()) {
    console.log(chalk.yellow("  ⚠ not installed — install from https://cli.github.com"));
  } else {
    console.log(chalk.dim(`  ${ghVersion() ?? "unknown version"}`));
  }

  const accounts = isInstalled() ? authStatus() : [];
  const accountByUser = new Map(accounts.map((a) => [a.user, a]));

  console.log("\n" + chalk.bold("Profiles"));
  if (config.profiles.length === 0) {
    console.log(chalk.dim("  (none)"));
  } else {
    for (const p of config.profiles) {
      const acct = accountByUser.get(p.ghUser);
      let state: string;
      if (!isInstalled()) state = chalk.dim("gh missing");
      else if (!acct) state = chalk.yellow("not signed in");
      else if (acct.active) state = chalk.green("signed in (active)");
      else state = chalk.green("signed in");
      console.log(`  ${chalk.cyan(p.name.padEnd(16))} → ${chalk.cyan(p.ghUser.padEnd(28))} ${state}`);
    }
  }

  console.log("\n" + chalk.bold("Mappings"));
  if (config.mappings.length === 0) {
    console.log(chalk.dim("  (none) — every git request will passthrough to GCM"));
  } else {
    const sorted = [...config.mappings].sort((a, b) => b.prefix.length - a.prefix.length);
    for (const m of sorted) {
      console.log(`  ${chalk.cyan(m.profile.padEnd(16))} ${m.prefix}`);
    }
  }

  if (accounts.length > 0) {
    const orphans = accounts.filter((a) => !config.profiles.some((p) => p.ghUser === a.user));
    if (orphans.length > 0) {
      console.log("\n" + chalk.bold("gh accounts not bound to any profile"));
      for (const o of orphans) {
        console.log(chalk.dim(`  ${o.user}`));
      }
    }
  }
}
