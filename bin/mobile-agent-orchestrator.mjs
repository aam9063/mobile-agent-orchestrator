#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { detectHosts } from "../lib/detect.mjs";
import { scopes, targets, resolveDestination } from "../lib/hosts.mjs";
import { inspectInstallations, buildPlan, executePlan, buildUninstallPlan, executeUninstallPlan } from "../lib/installer.mjs";
import { selectInstallPlan } from "../lib/prompt.mjs";

const usage = `Usage:
  mobile-agent-orchestrator install --target <name> [--target <name> ...] --scope <user|project> [--dry-run]
  mobile-agent-orchestrator install
  mobile-agent-orchestrator status [--target <name>]... [--scope <user|project>]
  mobile-agent-orchestrator uninstall --target <name> [--target <name> ...] [--scope <user|project>] [--dry-run]

With no arguments the installer runs interactively: it detects installed coding-agent CLIs, asks
which targets to configure and which scope to use, and shows the plan before writing anything.
Interactive mode requires BOTH stdin and stdout to be terminals (TTYs); a piped stdin with a
terminal stdout is treated as non-interactive. CI and automation must use the explicit-flag form
above.

Targets: ${targets.join(", ")}
Scopes:  ${scopes.join(", ")} (required with --target, no default)

Options:
  --target <name>  Host target to install for; repeatable. Omit to select interactively.
  --scope <scope>  user (~/.agents/skills) or project (<cwd>/.agents/skills). With no --target it
                   preselects the interactive scope question.
  --dry-run        Print the exact plan and write nothing.
  --help           Show this help.

Status (strictly read-only):
  mobile-agent-orchestrator status inspects installations without writing anything. By default it
  inspects every write target in BOTH scopes (pi is detect-only and has no managed destination, so
  it is never inspected). Each inspected destination prints one line:

    STATUS [scope] destination (targets)

  where STATUS is absent, managed, outdated, modified, or unknown, followed by indented detail
  lines when a destination needs attention. When both scopes resolve to the same destination
  (e.g. the working directory is the home directory), it is inspected once and reported with
  both scopes: STATUS [user, project] destination (targets).

Status options:
  --target <name>  Limit inspection to these targets; repeatable; defaults to all write targets.
  --scope <scope>  Limit inspection to user or project; defaults to both.

Exit codes:
  0  every inspected destination is absent or managed (nothing needs attention).
  1  at least one destination is outdated, modified, or unknown, or a usage/validation error
     occurred.

Uninstall (removes only installer-managed content):
  mobile-agent-orchestrator uninstall removes only the files recorded in the installation manifest,
  the directories those files leave empty, and the manifest itself. Unmanaged files are kept. A
  locally modified managed file blocks its whole destination and nothing is removed there. Targets
  sharing one .agents/skills directory (codex, opencode, gemini) are installed as one copy and are
  removed as that single copy. By default BOTH scopes are planned; pass --scope to narrow it.
  Destinations that both scopes resolve to (e.g. the working directory is the home directory)
  are planned once and reported with both scopes: uninstall [user, project] destination.

Uninstall options:
  --target <name>  Host target to uninstall for; repeatable; REQUIRED.
  --scope <scope>  Limit the uninstall to user (~/.agents/skills) or project (<cwd>/.agents/skills);
                   defaults to both.
  --dry-run        Print the exact removal plan and write nothing.

Uninstall exit codes:
  0  every planned destination was uninstalled or was already absent (nothing to remove).
  1  at least one destination is blocked (modified or unsafe content) or unknown, or a
     usage/validation error occurred.
`;

/**
 * Default interactive-mode derivation: BOTH stdin and stdout must be terminals. Checking only
 * stdout let a piped stdin (e.g. `printf '2\\n2\\ny\\n' | mao install` from a real terminal)
 * drive the interactive prompts and write files without explicit flags. stdin.isTTY alone is
 * not sufficient either: a redirected stdout means the prompts are not visible to a human.
 *
 * @param {{ isTTY?: boolean | undefined }} stdin
 * @param {{ isTTY?: boolean | undefined }} stdout
 * @returns {boolean}
 */
export function deriveInteractiveTTY(stdin, stdout) {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

/** The version recorded in installed manifests and compared against by `status`. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readInstallerVersion() {
  return JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).version;
}

function fail(errorOutput, message) {
  errorOutput.write(`${message}\n`);
  return 1;
}

function parseArguments(argv, { allowDryRun = true } = {}) {
  const selectedTargets = [];
  let scope = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (!allowDryRun) throw new Error(`Unknown argument: ${argument}.`);
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

/**
 * Targets sharing one destination (codex, opencode, gemini in .agents/skills) are installed as one
 * copy and are removed as that single copy, so an uninstall of any one of them must report — and
 * conceptually plan for — every target the copy serves. The expansion is scope-independent (each
 * target's location segments are fixed), so resolving through the user scope is exact for both.
 * It never adds a destination: expanded targets share the destination of a selected one by
 * construction, and a blocked destination refuses all-or-nothing regardless (S7).
 */
function expandSharedTargets(selectedTargets, { cwd, home }) {
  const destinationGroups = new Map();
  for (const target of targets) {
    const destination = resolveDestination(target, "user", { cwd, home });
    const group = destinationGroups.get(destination) ?? [];
    group.push(target);
    destinationGroups.set(destination, group);
  }
  const expanded = new Set();
  for (const target of selectedTargets) {
    for (const member of destinationGroups.get(resolveDestination(target, "user", { cwd, home }))) expanded.add(member);
  }
  return [...expanded];
}

/**
 * Render an uninstall plan: one status header per destination followed by the exact removals,
 * directory cleanup, manifest removal, preserved unmanaged files, and the blocking details of
 * blocked/unknown destinations. The trailing "N destination(s) inspected" summary is written by
 * the caller so the executed path can interleave its "removed" result lines before it.
 */
function renderUninstallPlan(output, plan) {
  for (const entry of plan.destinations) {
    output.write(`${entry.status} [${entry.scopes.join(", ")}] ${entry.destination} (${entry.targets.join(", ")})\n`);
    for (const removal of entry.removals) output.write(`  - remove ${removal.destination}\n`);
    for (const directory of entry.directories) output.write(`  - remove directory ${directory}\n`);
    if (entry.manifestRemoved) output.write(`  - remove manifest ${entry.manifestPath}\n`);
    for (const unmanaged of entry.unmanagedFiles) {
      output.write(`  - keep ${join(entry.destination, ...unmanaged.split("/"))} (unmanaged)\n`);
    }
    if (entry.status === "blocked" || entry.status === "unknown") {
      for (const detail of entry.details) output.write(`  - ${detail}\n`);
    } else if (entry.status === "uninstall") {
      // Informational details (e.g. already-absent recorded files) are part of the exact plan the
      // dry-run contract promises; `(unmanaged)` details are already rendered as `keep` above.
      for (const detail of entry.details) {
        if (!detail.endsWith("(unmanaged)")) output.write(`  - ${detail}\n`);
      }
    }
  }
}

/**
 * Stream proxy pair that lets an explicit `--scope` value skip the interactive scope question
 * without modifying lib/prompt.mjs. selectInstallPlan renders every non-prompt line with a
 * trailing newline, so a write that does not end in "\n" is exactly a prompt awaiting an answer.
 * The proxy suppresses the scope-question rendering (from its header up to that section's prompt,
 * the first prompt-like write after the header, so it can never swallow later output), answers
 * that prompt itself with the preselected value, and releases the user's buffered input one line
 * per remaining prompt so no user line is consumed by the skipped question.
 */
function createScopePreselectedFlow(input, output, scopeAnswer) {
  const queuedLines = [];
  let partialLine = "";
  let inputEnded = false;
  let scopeInjected = false;
  let sourceEnded = false;
  let promptOpen = false;
  let promptText = "";
  let suppressingScopeQuestion = false;

  const source = new Readable({ read() {} });

  const maybeEndSource = () => {
    if (inputEnded && queuedLines.length === 0 && !sourceEnded) {
      sourceEnded = true;
      source.push(null);
    }
  };

  const tryDeliver = () => {
    if (!promptOpen) return;
    if (!scopeInjected && promptText.startsWith("Select scope")) {
      scopeInjected = true;
      promptOpen = false;
      source.push(`${scopeAnswer}\n`);
      maybeEndSource();
    } else if (queuedLines.length > 0) {
      promptOpen = false;
      source.push(queuedLines.shift());
      maybeEndSource();
    }
  };

  const outputProxy = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      if (suppressingScopeQuestion) {
        // Skip the scope-question rendering; it always ends at its own prompt.
        if (!text.endsWith("\n")) {
          suppressingScopeQuestion = false;
          promptOpen = true;
          promptText = text;
          tryDeliver();
        }
        callback();
        return;
      }
      if (!scopeInjected && text.includes("Select scope:")) {
        suppressingScopeQuestion = true;
        callback();
        return;
      }
      output.write(chunk);
      if (!text.endsWith("\n")) {
        promptOpen = true;
        promptText = text;
        tryDeliver();
      }
      callback();
    },
  });

  const queueChunk = (text) => {
    const pieces = (partialLine + text).split("\n");
    partialLine = pieces.pop();
    for (const piece of pieces) queuedLines.push(`${piece}\n`);
    tryDeliver();
  };
  const endInput = () => {
    if (partialLine.length > 0) queuedLines.push(partialLine);
    partialLine = "";
    inputEnded = true;
    tryDeliver();
    maybeEndSource();
  };
  const onData = (chunk) => queueChunk(chunk.toString());
  input.on("data", onData);
  input.on("end", endInput);
  input.on("error", endInput);

  return {
    input: source,
    output: outputProxy,
    /**
     * Detach from the real input stream: remove every listener this flow attached and stop
     * pumping it. selectInstallPlan disposes its own inner line reader (attached to `source`)
     * in its finally, so this only needs to cover the listeners on the caller-supplied input;
     * without it, listeners left on a terminal-backed stdin keep the process alive after the
     * interactive flow completes.
     */
    dispose() {
      input.removeListener("data", onData);
      input.removeListener("end", endInput);
      input.removeListener("error", endInput);
      if (typeof input.pause === "function") input.pause();
      // Unref-style cleanup only fires on real handle-backed streams (e.g. process.stdin);
      // in-memory fixtures such as PassThrough/Readable have no unref and are unaffected.
      if (typeof input.unref === "function") input.unref();
    },
  };
}

/**
 * Testable CLI entry point. Interactive behavior is fully injectable (streams, TTY flag, home,
 * cwd, host detection); the explicit-flag path never touches any of them. Returns the process
 * exit code (0 on success, 1 on failure).
 *
 * @param {string[]} argv - Arguments after the program name.
 * @param {{
 *   input?: import("node:stream").Readable,
 *   output?: import("node:stream").Writable,
 *   errorOutput?: import("node:stream").Writable,
 *   isTTY?: boolean,
 *   home?: string,
 *   cwd?: string,
 *   detect?: typeof detectHosts,
 * }} [options]
 */
export async function run(argv, options = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    isTTY = deriveInteractiveTTY(process.stdin, process.stdout),
    home = homedir(),
    cwd = process.cwd(),
    detect = detectHosts,
  } = options;

  const [command, ...rest] = argv;
  if (command === "--help" || command === "help") {
    output.write(`${usage}\n`);
    return 0;
  }
  if (command !== "install" && command !== "status" && command !== "uninstall") {
    return fail(errorOutput, command === undefined ? "Missing subcommand." : `Unknown subcommand: ${command}.`);
  }

  if (command === "status") {
    let parsed;
    try {
      parsed = parseArguments(rest, { allowDryRun: false });
    } catch (error) {
      return fail(errorOutput, error.message);
    }
    // Same validation and messages as the install path; no default scope (both by default).
    if (parsed.scope && !scopes.includes(parsed.scope)) {
      return fail(errorOutput, `Unknown scope: ${parsed.scope}. Expected one of: ${scopes.join(", ")}.`);
    }
    const invalidTarget = parsed.selectedTargets.find((target) => !targets.includes(target));
    if (invalidTarget) return fail(errorOutput, `Unknown target: ${invalidTarget}. Expected one of: ${targets.join(", ")}.`);
    const selectedTargets = parsed.selectedTargets.length > 0 ? parsed.selectedTargets : [...targets];
    const selectedScopes = parsed.scope ? [parsed.scope] : [...scopes];
    let entries;
    try {
      entries = inspectInstallations({
        targets: selectedTargets,
        scopes: selectedScopes,
        cwd,
        home,
        installerVersion: readInstallerVersion(),
      });
    } catch (error) {
      return fail(errorOutput, `Status inspection failed: ${error.message}`);
    }
    let attentionNeeded = false;
    for (const entry of entries) {
      output.write(`${entry.status} [${entry.scopes.join(", ")}] ${entry.destination} (${entry.targets.join(", ")})\n`);
      for (const detail of entry.details) output.write(`  - ${detail}\n`);
      if (entry.status === "outdated" || entry.status === "modified" || entry.status === "unknown") attentionNeeded = true;
    }
    output.write(`${entries.length} destination(s) inspected\n`);
    return attentionNeeded ? 1 : 0;
  }

  if (command === "uninstall") {
    // Same parser as install, so --dry-run is accepted (S5) and every validation message is
    // identical to install's. Unlike install there is no interactive fallback: uninstall is
    // destructive, so --target is required and --dry-run is the safety net (design decision 6).
    let parsed;
    try {
      parsed = parseArguments(rest);
    } catch (error) {
      return fail(errorOutput, error.message);
    }
    if (parsed.selectedTargets.length === 0) {
      return fail(errorOutput, `Missing required --target (${targets.join(", ")}); no default is provided.`);
    }
    if (parsed.scope && !scopes.includes(parsed.scope)) {
      return fail(errorOutput, `Unknown scope: ${parsed.scope}. Expected one of: ${scopes.join(", ")}.`);
    }
    const invalidTarget = parsed.selectedTargets.find((target) => !targets.includes(target));
    if (invalidTarget) return fail(errorOutput, `Unknown target: ${invalidTarget}. Expected one of: ${targets.join(", ")}.`);
    const selectedScopes = parsed.scope ? [parsed.scope] : [...scopes];
    const selectedTargets = expandSharedTargets(parsed.selectedTargets, { cwd, home });
    let plan;
    try {
      plan = buildUninstallPlan({ targets: selectedTargets, scopes: selectedScopes, cwd, home });
    } catch (error) {
      return fail(errorOutput, `Uninstall planning failed: ${error.message}`);
    }
    renderUninstallPlan(output, plan);
    if (!parsed.dryRun) {
      let result;
      try {
        result = executeUninstallPlan(plan);
      } catch (error) {
        errorOutput.write(
          `Uninstall failed partway through; the destination may be inconsistent. Re-running the uninstall or install repairs it. (${error.message})\n`,
        );
        return 1;
      }
      for (const path of result.removedFiles) output.write(`  - removed ${path}\n`);
      for (const directory of result.removedDirectories) output.write(`  - removed directory ${directory}\n`);
    }
    const blockedOrUnknown = plan.destinations.some((entry) => entry.status === "blocked" || entry.status === "unknown");
    output.write(`${plan.destinations.length} destination(s) inspected\n`);
    return blockedOrUnknown ? 1 : 0;
  }

  let parsed;
  try {
    parsed = parseArguments(rest);
  } catch (error) {
    return fail(errorOutput, error.message);
  }

  let selectedTargets;
  let scope;
  if (parsed.selectedTargets.length === 0) {
    // Interactive path. An explicit --scope is validated first, exactly like the explicit path,
    // and then preselects the scope question.
    if (parsed.scope && !scopes.includes(parsed.scope)) {
      return fail(errorOutput, `Unknown scope: ${parsed.scope}. Expected one of: ${scopes.join(", ")}.`);
    }
    if (!isTTY) {
      return fail(
        errorOutput,
        "Interactive install requires a TTY. For CI or non-interactive shells, pass explicit flags: --target <name> and --scope <user|project>.",
      );
    }
    const hosts = detect({ home });
    const flow = parsed.scope
      ? createScopePreselectedFlow(input, output, parsed.scope)
      : { input, output, dispose: null };
    let selection;
    try {
      selection = await selectInstallPlan({ hosts, input: flow.input, output: flow.output });
    } finally {
      // Every exit path must release the real input stream. In the preselected case this
      // removes the proxy's listeners; otherwise selectInstallPlan's own finally already
      // disposed the line reader attached directly to the input.
      if (typeof flow.dispose === "function") flow.dispose();
    }
    if (selection === null) {
      output.write("Install cancelled; nothing was written.\n");
      return 0;
    }
    selectedTargets = selection.targets;
    scope = selection.scope;
  } else {
    if (!parsed.scope) return fail(errorOutput, "Missing required --scope (user or project); no default is provided.");
    if (!scopes.includes(parsed.scope)) return fail(errorOutput, `Unknown scope: ${parsed.scope}. Expected one of: ${scopes.join(", ")}.`);
    const invalidTarget = parsed.selectedTargets.find((target) => !targets.includes(target));
    if (invalidTarget) return fail(errorOutput, `Unknown target: ${invalidTarget}. Expected one of: ${targets.join(", ")}.`);
    selectedTargets = parsed.selectedTargets;
    scope = parsed.scope;
  }

  const root = packageRoot;
  let plan;
  try {
    plan = buildPlan({
      targets: selectedTargets,
      scope,
      cwd,
      home,
      skillRoot: resolve(root, "skills", "mobile-agent-orchestrator"),
      installerVersion: readInstallerVersion(),
    });
  } catch (error) {
    return fail(errorOutput, `Install planning failed: ${error.message}`);
  }

  let result;
  try {
    result = executePlan(plan, { dryRun: parsed.dryRun });
  } catch (error) {
    errorOutput.write(
      `Install failed partway through; the destination may be inconsistent. Re-running the install repairs it. (${error.message})\n`,
    );
    return 1;
  }

  if (result.status === "aborted") {
    errorOutput.write("Install aborted; nothing was written. Conflicting destination content:\n");
    for (const conflict of result.conflicts) errorOutput.write(`- ${conflict}\n`);
    return 1;
  }
  if (parsed.dryRun) {
    output.write(`Dry run; nothing was written. Plan (${result.status}):\n`);
    output.write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }
  if (result.status === "up-to-date") {
    output.write(`Already up to date: ${plan.destinations.map((entry) => entry.destination).join(", ")}\n`);
    return 0;
  }
  for (const destination of plan.destinations) {
    output.write(`Installed for ${destination.targets.join(", ")} -> ${destination.destination}\n`);
    for (const file of destination.files) output.write(`  ${file.action.padEnd(8)} ${file.path}\n`);
    output.write(`  manifest ${destination.manifestPath}\n`);
  }
  return 0;
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = await run(process.argv.slice(2));
}
