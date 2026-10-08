import { resolveUniqueDestinations, targets as writableTargets } from "./hosts.mjs";

/**
 * Skill directory name written under each destination. Kept in sync with `SKILL_DIRECTORY` in
 * lib/hosts.mjs (not exported there).
 */
const SKILL_DIRECTORY = "mobile-agent-orchestrator";

/** Exact install suggestion rendered for Pi, which is detect-only and never a write target. */
const PI_INSTALL_COMMAND = "pi install npm:mobile-agent-orchestrator";

/** Destination hints shown next to the scope choices. */
const SCOPE_HINTS = {
  user: "~/.agents/skills and ~/.claude/skills",
  project: "<cwd>/.agents/skills and <cwd>/.claude/skills",
};

/**
 * Default destination renderer: groups via the real dedup logic in lib/hosts.mjs using display
 * label roots ("~" / "<cwd>"), then renders portable forward-slash labels. This module never
 * touches the filesystem, so the label roots are never resolved as real paths by the caller.
 */
function defaultDescribeDestinations(selectedTargets, scope) {
  const base = scope === "user" ? "~" : "<cwd>";
  const groups = resolveUniqueDestinations(selectedTargets, scope, { home: "/~", cwd: "/<cwd>" });
  return groups.map((group) => {
    const segments = group.destination.split(/[\\/]+/);
    const directory = segments.includes(".claude") ? ".claude/skills" : ".agents/skills";
    return `${base}/${directory}/${SKILL_DIRECTORY} (${group.targets.join(", ")})`;
  });
}

/**
 * Minimal line reader over an injected readable stream. Answers are never echoed: only the
 * prompt strings are written to `output`, and input is consumed silently. A trailing line
 * without a newline is delivered once at end-of-input (mirroring node:readline); every read
 * after end-of-input resolves to `null`, which callers treat as cancellation.
 */
function createLineReader(input) {
  let buffer = "";
  let ended = false;
  let pending = null;

  const settle = (line) => {
    const reader = pending;
    pending = null;
    reader.resolve(line);
  };

  const flush = () => {
    if (!pending) return;
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      settle(line);
    } else if (ended) {
      const line = buffer.length > 0 ? buffer.replace(/\r$/, "") : null;
      buffer = "";
      settle(line);
    }
  };

  input.on("data", (chunk) => {
    buffer += chunk.toString();
    flush();
  });
  input.on("end", () => {
    ended = true;
    flush();
  });
  input.on("error", () => {
    ended = true;
    flush();
  });

  return {
    readLine() {
      if (pending) throw new Error("Concurrent readLine calls are not supported.");
      return new Promise((resolve) => {
        pending = { resolve };
        flush();
      });
    },
  };
}

/**
 * Split hosts into the rendered list lines and the ordered selectable target ids. Pi is rendered
 * as an informational line with the supported install command and is never selectable. Unknown
 * host ids are ignored (the prompt module is a pass-through over detection results).
 */
function renderHostList(hosts) {
  const knownTargets = new Set(writableTargets);
  const lines = [];
  const selectable = [];
  for (const host of hosts) {
    if (host.id === "pi") {
      lines.push(`  pi - detect-only; install with: ${PI_INSTALL_COMMAND}`);
      continue;
    }
    if (!knownTargets.has(host.id)) continue;
    const number = selectable.length + 1;
    selectable.push(host.id);
    const status = host.detected
      ? `detected${host.evidence ? ` (${host.evidence})` : ""}`
      : "not detected";
    lines.push(`  [${number}] ${host.id} - ${status}`);
  }
  return { lines, selectable };
}

/**
 * Parse a multi-select answer. Accepts the alias "a"/"all" (case-insensitive) for every
 * selectable target, or comma-separated numbers. Duplicates collapse; the result is normalized
 * to the canonical selectable order. Returns null when any token is invalid (no partial
 * acceptance of garbage).
 */
function parseSelection(line, selectable) {
  const normalized = line.trim().toLowerCase();
  if (normalized === "a" || normalized === "all") return [...selectable];
  if (normalized.length === 0) return null;
  const chosen = new Set();
  for (const token of normalized.split(",")) {
    if (!/^\d+$/.test(token.trim())) return null;
    const number = Number(token.trim());
    if (number < 1 || number > selectable.length) return null;
    chosen.add(selectable[number - 1]);
  }
  return selectable.filter((id) => chosen.has(id));
}

/** Parse a scope answer ("1"/"user" or "2"/"project", case-insensitive); null when invalid. */
function parseScope(line) {
  const normalized = line.trim().toLowerCase();
  if (normalized === "1" || normalized === "user") return "user";
  if (normalized === "2" || normalized === "project") return "project";
  return null;
}

/**
 * Deterministic interactive selection flow with fully injected streams. Renders the detected
 * hosts, asks for targets, scope, and confirmation, and returns `{ targets, scope }` on
 * confirmation or `null` on cancellation (end-of-input at any prompt, or any non-confirm answer
 * at the confirmation step). Reads no filesystem state beyond its arguments and performs no
 * writes; the caller owns all filesystem effects.
 *
 * @param {{
 *   hosts: Array<{ id: string, detected: boolean, evidence: string }>,
 *   input: import("node:stream").Readable,
 *   output: import("node:stream").Writable,
 *   describeDestinations?: (selectedTargets: string[], scope: string) => string[],
 * }} options
 * @returns {Promise<{ targets: string[], scope: string } | null>}
 */
export async function selectInstallPlan({
  hosts,
  input,
  output,
  describeDestinations = defaultDescribeDestinations,
}) {
  if (!Array.isArray(hosts)) {
    throw new TypeError("selectInstallPlan requires a hosts array from detectHosts().");
  }
  if (!input || typeof input.on !== "function") {
    throw new TypeError("selectInstallPlan requires an injectable input stream.");
  }
  if (!output || typeof output.write !== "function") {
    throw new TypeError("selectInstallPlan requires an injectable output stream.");
  }

  output.write("Detected coding-agent CLIs:\n");
  const { lines, selectable } = renderHostList(hosts);
  for (const line of lines) output.write(`${line}\n`);
  if (selectable.length === 0) {
    output.write("No installable coding-agent targets are supported.\n");
    return null;
  }

  const reader = createLineReader(input);

  let selected = null;
  while (selected === null) {
    output.write(
      `Select targets to install (comma-separated numbers 1-${selectable.length}, or "a" for all): `,
    );
    const answer = await reader.readLine();
    if (answer === null) return null;
    selected = parseSelection(answer, selectable);
    if (selected === null) {
      output.write(
        `Invalid selection. Enter comma-separated numbers between 1 and ${selectable.length}, or "a" for all.\n`,
      );
    }
  }

  output.write("\nSelect scope:\n");
  output.write(`  [1] user - installs to ${SCOPE_HINTS.user}\n`);
  output.write(`  [2] project - installs to ${SCOPE_HINTS.project}\n`);
  let scope = null;
  while (scope === null) {
    output.write("Select scope (1/2): ");
    const answer = await reader.readLine();
    if (answer === null) return null;
    scope = parseScope(answer);
    if (scope === null) {
      output.write('Invalid scope. Enter "1" (user) or "2" (project).\n');
    }
  }

  output.write("\nInstall plan:\n");
  output.write(`  scope: ${scope}\n`);
  output.write("  destinations:\n");
  for (const line of describeDestinations(selected, scope)) {
    output.write(`    ${line}\n`);
  }
  output.write("Proceed? [y/N] ");
  const confirmation = await reader.readLine();
  if (confirmation === null) return null;
  if (!/^(?:y|yes)$/i.test(confirmation.trim())) return null;
  return { targets: selected, scope };
}
