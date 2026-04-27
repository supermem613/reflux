#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { doctorCommand } from "./commands/doctor.js";
import { installCommand, uninstallCommand } from "./commands/install.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import {
  mapAddCommand,
  mapListCommand,
  mapRemoveCommand,
  mapResolveCommand,
} from "./commands/map.js";
import {
  profileAddCommand,
  profileListCommand,
  profileRemoveCommand,
  profileShowCommand,
} from "./commands/profile.js";
import { statusCommand } from "./commands/status.js";
import { updateCommand } from "./commands/update.js";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const VERSION = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;

const program = new Command();

program
  .name("reflux")
  .description("Per-identity GitHub credential router for Windows. Routes git auth requests to the right `gh` account.");

program
  .command("doctor")
  .description("Health check: gh present? GCM present? config valid? each profile signed in?")
  .action(doctorCommand);

program
  .command("install")
  .description("Register git-credential-reflux for github.com in ~/.gitconfig")
  .action(installCommand);

program
  .command("login")
  .description("Sign into GitHub for a profile (delegates to `gh auth login`)")
  .argument("<profile>", "Profile name to sign in")
  .action(loginCommand);

program
  .command("logout")
  .description("Sign the profile's gh user out (delegates to `gh auth logout`)")
  .argument("<profile>", "Profile name to log out")
  .action(logoutCommand);

const map = program
  .command("map")
  .description("Manage remote-URL → profile mappings");

map
  .command("add")
  .description("Map a URL prefix to a profile (longest-prefix wins on resolution)")
  .argument("<prefix>", "URL prefix to match (e.g. https://github.com/microsoft/)")
  .argument("<profile>", "Profile to route matching URLs to")
  .action(mapAddCommand);

map
  .command("list")
  .description("List all mappings, sorted by prefix length (resolution order)")
  .action(mapListCommand);

map
  .command("remove")
  .description("Remove a mapping by prefix")
  .argument("<prefix>", "URL prefix to remove")
  .action(mapRemoveCommand);

map
  .command("resolve")
  .description("Show which profile a remote URL would resolve to")
  .argument("<url>", "Remote URL to test")
  .action(mapResolveCommand);

const profile = program
  .command("profile")
  .description("Manage identity profiles");

profile
  .command("add")
  .description("Create a new profile bound to a gh user")
  .argument("<name>", "Profile name (lowercase letters, digits, hyphens)")
  .requiredOption("--gh-user <login>", "GitHub login as it appears in `gh auth status`")
  .action((name, opts) => profileAddCommand(name, opts));

profile
  .command("list")
  .description("List all profiles and whether their gh user is signed in")
  .action(profileListCommand);

profile
  .command("remove")
  .description("Remove a profile and any mappings pointing at it (does NOT touch gh)")
  .argument("<name>", "Profile name to remove")
  .action(profileRemoveCommand);

profile
  .command("show")
  .description("Show details for a single profile")
  .argument("<name>", "Profile name")
  .action(profileShowCommand);

program
  .command("status")
  .description("Show profiles, mappings, and gh sign-in state")
  .action(statusCommand);

program
  .command("uninstall")
  .description("Remove git-credential-reflux from git config")
  .action(uninstallCommand);

program
  .command("update")
  .description("Self-update: git pull, npm install, npm run build")
  .action(updateCommand);

if (process.argv.slice(2).length === 0) {
  process.stdout.write(`reflux v${VERSION}\n\n`);
  program.outputHelp();
  process.exit(0);
}

program.parseAsync().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`reflux: ${msg}\n`);
  process.exit(1);
});
