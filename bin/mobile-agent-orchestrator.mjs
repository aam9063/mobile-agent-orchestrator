#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scopes, targets } from "../lib/hosts.mjs";
import { buildPlan, executePlan } from "../lib/installer.mjs";

const usage = `Usage:
  mobile-agent-orchestrator install --target <name> [--target <name> ...] --scope <user|project> [--dry-run]

Targets: ${targets.join(", ")}
Scopes:  ${scopes.join(", ")} (required, no default)

Options:
  --target <name>  Host target to install for; repeatable.
  --scope <scope>  user (~/.agents/skills) or project (<cwd>/.agents/skills).
  --dry-run        Print the exact plan and write nothing.
  --help           Show this help.
`;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  return 1;
}

function parseArguments(argv) {
  const selectedTargets = [];
  let scope = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--target") {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error("--target requires a value.");
      if (!selectedTargets.includes(value)) selectedTargets.push(value);
    } else if (argument === "--scope") {
      index += 1;
      scope = argv[index];
      if (scope === undefined) throw new Error("--scope requires a value.");
    } else {
      throw new Error(`Unknown argument: ${argument}.`);
    }
  }
  return { selectedTargets, scope, dryRun };
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "help") {
    console.log(usage);
    return 0;
  }
  if (command !== "install") {
    return fail(command === undefined ? "Missing subcommand." : `Unknown subcommand: ${command}.`);
  }

  let parsed;
  try {
    parsed = parseArguments(rest);
  } catch (error) {
    return fail(error.message);
  }
  if (parsed.selectedTargets.length === 0) return fail(`Missing required --target. Expected one of: ${targets.join(", ")}.`);
  if (!parsed.scope) return fail("Missing required --scope (user or project); no default is provided.");
  if (!scopes.includes(parsed.scope)) return fail(`Unknown scope: ${parsed.scope}. Expected one of: ${scopes.join(", ")}.`);
  const invalidTarget = parsed.selectedTargets.find((target) => !targets.includes(target));
  if (invalidTarget) return fail(`Unknown target: ${invalidTarget}. Expected one of: ${targets.join(", ")}.`);

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let plan;
  try {
    plan = buildPlan({
      targets: parsed.selectedTargets,
      scope: parsed.scope,
      cwd: process.cwd(),
      home: homedir(),
      skillRoot: resolve(root, "skills", "mobile-agent-orchestrator"),
      installerVersion: JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version,
    });
  } catch (error) {
    return fail(`Install planning failed: ${error.message}`);
  }

  let result;
  try {
    result = executePlan(plan, { dryRun: parsed.dryRun });
  } catch (error) {
    console.error(
      `Install failed partway through; the destination may be inconsistent. Re-running the install repairs it. (${error.message})`,
    );
    process.exitCode = 1;
    return 1;
  }

  if (result.status === "aborted") {
    console.error("Install aborted; nothing was written. Conflicting destination content:");
    for (const conflict of result.conflicts) console.error(`- ${conflict}`);
    return 1;
  }
  if (parsed.dryRun) {
    console.log(`Dry run; nothing was written. Plan (${result.status}):`);
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  if (result.status === "up-to-date") {
    console.log(`Already up to date: ${plan.destinations.map((entry) => entry.destination).join(", ")}`);
    return 0;
  }
  for (const destination of plan.destinations) {
    console.log(`Installed for ${destination.targets.join(", ")} -> ${destination.destination}`);
    for (const file of destination.files) console.log(`  ${file.action.padEnd(8)} ${file.path}`);
    console.log(`  manifest ${destination.manifestPath}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
