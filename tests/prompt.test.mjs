import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { selectInstallPlan } from "../lib/prompt.mjs";

/**
 * Build a detectHosts-shaped fixture (pass-through; the prompt module must not detect anything).
 * Evidence presence encodes detection, mirroring lib/detect.mjs output.
 */
function makeHosts(evidenceById = {}) {
  const defaults = {
    pi: "config dir ~/.pi; found in PATH",
    "claude-code": "config dir ~/.claude; found in PATH",
    codex: "",
    opencode: "",
    gemini: "",
  };
  const merged = { ...defaults, ...evidenceById };
  return Object.entries(merged).map(([id, evidence]) => ({
    id,
    detected: evidence.length > 0,
    evidence,
  }));
}

/** Writable stream that records every chunk synchronously, for deterministic output asserts. */
function makeOutput() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

const countOccurrences = (text, needle) => text.split(needle).length - 1;

test("happy path: shared-destination pair, user scope, confirm returns deduped plan", async () => {
  const hosts = makeHosts({
    codex: "config dir ~/.codex; found in PATH",
    opencode: "found in PATH",
  });
  const input = Readable.from(["3,2\n", "1\n", "y\n"]);
  const out = makeOutput();

  const plan = await selectInstallPlan({ hosts, input, output: out.stream });

  assert.deepEqual(plan, { targets: ["codex", "opencode"], scope: "user" });
  const text = out.text();
  // Status rendering with evidence.
  assert.match(text, /\[1\] claude-code - detected \(config dir ~\/\.claude; found in PATH\)/);
  assert.match(text, /\[2\] codex - detected \(config dir ~\/\.codex; found in PATH\)/);
  assert.match(text, /\[3\] opencode - detected \(found in PATH\)/);
  // "3,2" is normalized to the canonical target order.
  assert.deepEqual(plan.targets, ["codex", "opencode"]);
  // Shared .agents/skills destination collapses to exactly one line naming both targets.
  assert.equal(countOccurrences(text, "mobile-agent-orchestrator (codex, opencode)"), 1);
  assert.match(text, /~\/\.agents\/skills\/mobile-agent-orchestrator \(codex, opencode\)/);
});

test('"all" alias selects the four selectable targets', async () => {
  const hosts = makeHosts();
  const input = Readable.from(["all\n", "2\n", "y\n"]);
  const out = makeOutput();

  const plan = await selectInstallPlan({ hosts, input, output: out.stream });

  assert.deepEqual(plan, {
    targets: ["claude-code", "codex", "opencode", "gemini"],
    scope: "project",
  });
});

test("invalid selection re-asks with a message, then duplicates are ignored", async () => {
  const hosts = makeHosts();
  const input = Readable.from(["9,abc\n", "1,1\n", "1\n", "y\n"]);
  const out = makeOutput();

  const plan = await selectInstallPlan({ hosts, input, output: out.stream });

  assert.deepEqual(plan, { targets: ["claude-code"], scope: "user" });
  assert.match(out.text(), /Invalid selection/);
});

test("EOF mid-flow returns null with no plan", async () => {
  const hosts = makeHosts();
  const input = Readable.from(["1,2\n"]); // input ends before the scope prompt is answered
  const out = makeOutput();

  const plan = await selectInstallPlan({ hosts, input, output: out.stream });

  assert.equal(plan, null);
  assert.doesNotMatch(out.text(), /Install plan/);
});

test("non-confirm answer at confirmation returns null", async () => {
  const hosts = makeHosts();
  const input = Readable.from(["1\n", "2\n", "n\n"]);
  const out = makeOutput();

  const plan = await selectInstallPlan({ hosts, input, output: out.stream });

  assert.equal(plan, null);
  // The plan summary was rendered before cancellation (project scope destination hints).
  assert.match(out.text(), /Install plan/);
  assert.match(out.text(), /<cwd>\/\.claude\/skills\/mobile-agent-orchestrator \(claude-code\)/);
});

test("pi renders the install suggestion as an unnumbered informational line", async () => {
  const hosts = makeHosts();
  const input = Readable.from(["1\n", "1\n", "y\n"]);
  const out = makeOutput();

  const plan = await selectInstallPlan({ hosts, input, output: out.stream });

  assert.deepEqual(plan, { targets: ["claude-code"], scope: "user" });
  const text = out.text();
  assert.match(text, /pi install npm:mobile-agent-orchestrator/);
  const piLine = text.split("\n").find((line) => line.includes("pi install npm:"));
  assert.ok(piLine, "pi suggestion line is rendered");
  assert.ok(!piLine.includes("["), "pi is not numbered/selectable");
  // Exactly the four writable targets carry numbers.
  for (const id of ["claude-code", "codex", "opencode", "gemini"]) {
    assert.doesNotMatch(text, new RegExp(`\\[5\\] ${id}`));
  }
});

test("undetected host stays selectable and is rendered as not detected", async () => {
  const hosts = makeHosts({ gemini: "" }); // everything undetected except pi
  const input = Readable.from(["4\n", "1\n", "y\n"]);
  const out = makeOutput();

  const plan = await selectInstallPlan({ hosts, input, output: out.stream });

  assert.deepEqual(plan, { targets: ["gemini"], scope: "user" });
  assert.match(out.text(), /\[4\] gemini - not detected/);
});

test('"Yes" confirms case-insensitively; anything else cancels', async () => {
  const hosts = makeHosts();
  const yes = await selectInstallPlan({
    hosts,
    input: Readable.from(["2\n", "1\n", "Yes\n"]),
    output: makeOutput().stream,
  });
  assert.deepEqual(yes, { targets: ["codex"], scope: "user" });

  const cancelled = await selectInstallPlan({
    hosts,
    input: Readable.from(["2\n", "1\n", "Y yes\n"]),
    output: makeOutput().stream,
  });
  assert.equal(cancelled, null);
});
