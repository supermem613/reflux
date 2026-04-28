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
 * `reflux update` — refresh the installed binary from the development clone.
 *
 * Two install topologies must work:
 *
 *   1. Dev-style (`npm link` from a clone): `import.meta.url` resolves to
 *      the clone itself. Pull / install / build in place — no global
 *      reinstall needed because the link points at this directory.
 *
 *   2. Production-style (`npm install -g <pkg>`): `import.meta.url`
 *      resolves to `<prefix>/node_modules/reflux/`, which is not a git
 *      repo. We need to find the dev clone elsewhere, refresh it, then
 *      `npm install -g` from it so the global bin shadow updates.
 *
 * Dev-clone discovery order:
 *   - $REFLUX_DEV_DIR (explicit override)
 *   - ~/repos/reflux  (the convention this project ships with)
 *
 * If neither is a git repo, we fail with instructions instead of guessing.
 */

interface UpdateTarget {
  dir: string;
  needsGlobalInstall: boolean;
}

function resolveModuleRoot(): string {
  // dist/commands/update.js → repo root is two `dirname`s up from the file
  // when running from a clone, or two up from inside node_modules/reflux/
  // when installed.
  const thisFile = fileURLToPath(import.meta.url);
  return dirname(dirname(dirname(thisFile)));
}

async function locateUpdateTarget(): Promise<UpdateTarget | null> {
  const moduleRoot = resolveModuleRoot();
  if (await isGitRepo(moduleRoot)) {
    return { dir: moduleRoot, needsGlobalInstall: false };
  }

  const candidates = [
    process.env.REFLUX_DEV_DIR,
    join(homedir(), "repos", "reflux"),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (await isGitRepo(candidate)) {
      return { dir: candidate, needsGlobalInstall: true };
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
    console.error(chalk.red("Error:") + " Reflux is installed from npm but no development clone was found.");
    console.error(chalk.dim("  Looked in:"));
    if (process.env.REFLUX_DEV_DIR) {
      console.error(chalk.dim(`    $REFLUX_DEV_DIR = ${process.env.REFLUX_DEV_DIR}`));
    }
    console.error(chalk.dim(`    ${join(homedir(), "repos", "reflux")}`));
    console.error(chalk.dim("\n  Either clone reflux to ~/repos/reflux or set REFLUX_DEV_DIR to your clone path."));
    process.exit(1);
  }

  console.log(chalk.dim(`  Reflux repo: ${target.dir}`));
  if (target.needsGlobalInstall) {
    console.log(chalk.dim(`  (running from npm install; will reinstall globally after build)\n`));
  } else {
    console.log("");
  }

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

  if (target.needsGlobalInstall) {
    // Reinstall the global bin from the freshly-built dev clone. Passing
    // the directory (not a tarball) lets npm wire up the bin shims to the
    // updated dist/ on every invocation, no repack step needed.
    await runStep("📦 Reinstalling global bin...", `npm install -g "${target.dir}"`, target.dir);
  }

  console.log(chalk.green("\n  ✓ Reflux updated successfully."));
}
