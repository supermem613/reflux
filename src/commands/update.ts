import chalk from "chalk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { git, isGitRepo } from "../utils/git.js";

const execAsync = promisify(exec);

/**
 * `reflux update` — refresh reflux from its development clone.
 *
 * Reflux is always installed via `npm link` from a local clone — never
 * `npm install -g`. The link makes `<npm-prefix>/node_modules/reflux` a
 * junction pointing at the clone, and the bin shim points into the same
 * clone's `dist/`. That means a successful rebuild updates the live
 * binary atomically, with no global install step.
 *
 * Topologies this command handles:
 *
 *   1. Linked install: `import.meta.url` resolves into the clone itself
 *      (because the junction is transparent to fileURLToPath). isGitRepo
 *      returns true, we update in place, done.
 *
 *   2. Stale or missing link: `import.meta.url` resolves into a copied
 *      `node_modules/reflux/` directory left over from an old global
 *      install. We locate the dev clone via $REFLUX_DEV_DIR or
 *      ~/repos/reflux, refresh it, then ask the user to re-run
 *      `npm link` from there. We do not silently `npm install -g` because
 *      that recreates the same brittle global-prefix mess we are trying
 *      to leave behind.
 */

interface UpdateTarget {
  dir: string;
  isLinked: boolean;
}

function resolveModuleRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(thisFile)));
}

async function locateUpdateTarget(): Promise<UpdateTarget | null> {
  const moduleRoot = resolveModuleRoot();
  if (await isGitRepo(moduleRoot)) {
    return { dir: moduleRoot, isLinked: true };
  }

  const candidates = [
    process.env.REFLUX_DEV_DIR,
    join(homedir(), "repos", "reflux"),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    if (await isGitRepo(candidate)) {
      return { dir: candidate, isLinked: false };
    }
  }
  return null;
}

async function runStep(label: string, cmd: string, cwd: string): Promise<void> {
  console.log(chalk.bold(`\n  ${label}`));
  try {
    await execAsync(cmd, { cwd });
    console.log(chalk.green(`    ✓ ${label.replace(/^[^\w]+\s*/, "")} done.`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`  ✗ ${label} failed:`) + ` ${msg}`);
    process.exit(1);
  }
}

export async function updateCommand(): Promise<void> {
  const target = await locateUpdateTarget();

  if (!target) {
    const moduleRoot = resolveModuleRoot();
    console.log(chalk.dim(`  Reflux module: ${moduleRoot}\n`));
    console.error(chalk.red("Error:") + " Reflux is not linked and no development clone was found.");
    console.error(chalk.dim("  Looked in:"));
    if (process.env.REFLUX_DEV_DIR) {
      console.error(chalk.dim(`    $REFLUX_DEV_DIR = ${process.env.REFLUX_DEV_DIR}`));
    }
    console.error(chalk.dim(`    ${join(homedir(), "repos", "reflux")}`));
    console.error(chalk.dim("\n  Clone reflux to ~/repos/reflux (or set REFLUX_DEV_DIR), then run `npm link` from there."));
    process.exit(1);
  }

  console.log(chalk.dim(`  Reflux repo: ${target.dir}\n`));

  console.log(chalk.bold("  ↓ Pulling latest..."));
  try {
    const result = await git(["pull", "--ff-only"], target.dir);
    const output = (result.stdout + result.stderr).trim();
    if (output.includes("Already up to date")) {
      console.log(chalk.dim("    Already up to date."));
    } else {
      console.log(chalk.green("    ✓ Pulled new changes."));
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("  ✗ git pull failed:") + ` ${msg}`);
    process.exit(1);
  }

  await runStep("⬡ Installing dependencies...", "npm install --no-audit --no-fund", target.dir);
  await runStep("🔨 Building...", "npm run build", target.dir);

  if (!target.isLinked) {
    // The dev clone was found via the fallback, but the running reflux is
    // not the linked clone — most likely a leftover global install. Ask
    // the user to run `npm link` from the clone so future invocations pick
    // up the rebuilt dist/ automatically.
    console.log(chalk.yellow("\n  ⚠  Reflux is not linked to this clone."));
    console.log(chalk.dim(`     Run:  cd ${target.dir} && npm link`));
    console.log(chalk.dim("     After that, `reflux update` will refresh in place with no global install."));
    return;
  }

  console.log(chalk.green("\n  ✓ Reflux updated successfully."));
}
