import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import { run } from "../bin/mobile-agent-orchestrator.mjs";

/**
 * Writable stream that records every chunk synchronously, for deterministic output asserts.
 */
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

/**
 * detectHosts-shaped fixture (the CLI must not detect anything real in tests; the injected
 * `detect` replaces lib/detect.mjs entirely).
 */
function makeHosts() {
  const evidenceById = {
    pi: "config dir ~/.pi; found in PATH",
    "claude-code": "config dir ~/.claude; found in PATH",
    codex: "",
    opencode: "",
    gemini: "",
  };
  return Object.entries(evidenceById).map(([id, evidence]) => ({
    id,
    detected: evidence.length > 0,
    evidence,
  }));
}

function makeTempDir(label) {
  return mkdtempSync(join(tmpdir(), `mao-cli-${label}-`));
}

test("no-args interactive install with a TTY runs the full flow and installs", async (t) => {
  const projectDir = makeTempDir("happy");
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const out = makeOutput();
  const err = makeOutput();

  const exit = await run(["install"], {
    input: Readable.from(["1\n", "2\n", "y\n"]), // claude-code target, project scope, confirm
    output: out.stream,
    errorOutput: err.stream,
    isTTY: true,
    home: join(projectDir, "home"),
    cwd: projectDir,
    detect: () => makeHosts(),
  });

  assert.equal(exit, 0);
  const text = out.text();
  // The listing comes from selectInstallPlan, including the pi suggestion line.
  assert.match(text, /pi install npm:mobile-agent-orchestrator/);
  // Same output shape as the explicit-flag path.
  assert.match(text, /Installed for claude-code -> /);
  const skillDir = join(projectDir, ".claude", "skills", "mobile-agent-orchestrator");
  assert.equal(existsSync(join(skillDir, "SKILL.md")), true);
  assert.equal(
    existsSync(join(projectDir, ".claude", "skills", ".mobile-agent-orchestrator.manifest.json")),
    true,
  );
  assert.equal(err.text(), "");
});

test("no-args interactive install cancelled at EOF exits 0 and writes nothing", async (t) => {
  const projectDir = makeTempDir("cancel");
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const out = makeOutput();

  const exit = await run(["install"], {
    input: Readable.from(["1\n"]), // input ends before the scope prompt is answered
    output: out.stream,
    errorOutput: makeOutput().stream,
    isTTY: true,
    home: join(projectDir, "home"),
    cwd: projectDir,
    detect: () => makeHosts(),
  });

  assert.equal(exit, 0);
  assert.match(out.text(), /Install cancelled; nothing was written\./);
  assert.equal(existsSync(join(projectDir, ".claude")), false);
  assert.equal(existsSync(join(projectDir, ".agents")), false);
});

test("no-args install without a TTY fails with the explicit-flags guidance and never prompts", async (t) => {
  const projectDir = makeTempDir("nontty");
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const out = makeOutput();
  const err = makeOutput();

  const exit = await run(["install"], {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: err.stream,
    isTTY: false,
    home: join(projectDir, "home"),
    cwd: projectDir,
    detect: () => makeHosts(),
  });

  assert.equal(exit, 1);
  const errorText = err.text();
  assert.match(errorText, /TTY/);
  assert.match(errorText, /--target/);
  assert.match(errorText, /--scope/);
  // No prompt was attempted on the output stream.
  assert.doesNotMatch(out.text(), /Select targets/);
  assert.equal(existsSync(join(projectDir, ".claude")), false);
  assert.equal(existsSync(join(projectDir, ".agents")), false);
});

test("explicit --target --scope --dry-run keeps the unchanged dry-run output", async (t) => {
  const projectDir = makeTempDir("dryrun");
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const out = makeOutput();
  const err = makeOutput();

  const exit = await run(["install", "--target", "codex", "--scope", "project", "--dry-run"], {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: err.stream,
    isTTY: false,
    home: join(projectDir, "home"),
    cwd: projectDir,
    detect: () => makeHosts(),
  });

  assert.equal(exit, 0);
  const text = out.text();
  assert.match(text, /Dry run; nothing was written\. Plan \(installed\):/);
  const plan = JSON.parse(text.slice(text.indexOf("{")));
  assert.equal(plan.scope, "project");
  assert.equal(plan.destinations.length, 1);
  assert.ok(plan.destinations[0].destination.startsWith(projectDir));
  assert.equal(err.text(), "");
});

test("explicit flags keep the exact validation errors", async (t) => {
  const base = { isTTY: true, home: "/unused-home", cwd: "/unused-cwd", detect: () => makeHosts() };
  const cases = [
    { argv: ["install", "--target", "codex"], message: /Missing required --scope/ },
    { argv: ["install", "--target", "bogus", "--scope", "user"], message: /Unknown target: bogus/ },
    { argv: ["install", "--target", "codex", "--scope", "root"], message: /Unknown scope: root/ },
    { argv: ["install", "--target", "codex", "--nope"], message: /Unknown argument: --nope/ },
  ];
  for (const { argv, message } of cases) {
    const err = makeOutput();
    const exit = await run(argv, { ...base, input: Readable.from([]), output: makeOutput().stream, errorOutput: err.stream });
    assert.equal(exit, 1, `expected exit 1 for ${argv.join(" ")}`);
    assert.match(err.text(), message);
  }
});

test("interactive install honors an explicitly passed --scope (scope question skipped)", async (t) => {
  const scopeDir = makeTempDir("prescope");
  t.after(() => rmSync(scopeDir, { recursive: true, force: true }));
  const home = join(scopeDir, "home");
  const out = makeOutput();

  const exit = await run(["install", "--scope", "user"], {
    input: Readable.from(["1\n", "y\n"]), // target answer, then confirm; no scope answer needed
    output: out.stream,
    errorOutput: makeOutput().stream,
    isTTY: true,
    home,
    cwd: join(scopeDir, "project"),
    detect: () => makeHosts(),
  });

  assert.equal(exit, 0);
  const text = out.text();
  // The scope question never ran; the preselected scope was used.
  assert.doesNotMatch(text, /Select scope/);
  assert.match(text, /Installed for claude-code -> /);
  assert.equal(existsSync(join(home, ".claude", "skills", "mobile-agent-orchestrator", "SKILL.md")), true);
});

test("an explicit --scope with no --target is validated before any prompting", async (t) => {
  const out = makeOutput();
  const err = makeOutput();

  const exit = await run(["install", "--scope", "root"], {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: err.stream,
    isTTY: true,
    home: "/unused-home",
    cwd: "/unused-cwd",
    detect: () => makeHosts(),
  });

  assert.equal(exit, 1);
  assert.match(err.text(), /Unknown scope: root/);
  assert.doesNotMatch(out.text(), /Select targets/);
});

/**
 * Open-ended stdin mock: a PassThrough that is never ended. The pre-fix code left its data/end/
 * error listeners attached after the interactive flow, which keeps a real TTY-backed stdin
 * handle alive; these tests assert run() resolves with the stream still open and no residual
 * listeners.
 */
test("open-input run with preselected --scope resolves and leaves no stdin listeners", async (t) => {
  const projectDir = makeTempDir("open-prescope");
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const out = makeOutput();
  const input = new PassThrough();

  const runPromise = run(["install", "--scope", "user"], {
    input,
    output: out.stream,
    errorOutput: makeOutput().stream,
    isTTY: true,
    home: join(projectDir, "home"),
    cwd: join(projectDir, "project"),
    detect: () => makeHosts(),
  });
  input.write("1\n"); // target answer
  input.write("y\n"); // confirm

  const exit = await runPromise;

  assert.equal(exit, 0);
  const text = out.text();
  assert.doesNotMatch(text, /Select scope/);
  assert.match(text, /Installed for claude-code -> /);
  // The stdin mock is still open and carries no residual listeners.
  assert.equal(input.writableEnded, false);
  assert.equal(input.readableEnded, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
});

test("open-input run without preselected scope resolves and leaves no stdin listeners", async (t) => {
  const projectDir = makeTempDir("open-noscope");
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const out = makeOutput();
  const input = new PassThrough();

  const runPromise = run(["install"], {
    input,
    output: out.stream,
    errorOutput: makeOutput().stream,
    isTTY: true,
    home: join(projectDir, "home"),
    cwd: projectDir,
    detect: () => makeHosts(),
  });
  input.write("1\n"); // target answer
  input.write("2\n"); // scope answer
  input.write("y\n"); // confirm

  const exit = await runPromise;

  assert.equal(exit, 0);
  assert.match(out.text(), /Installed for claude-code -> /);
  assert.equal(input.writableEnded, false);
  assert.equal(input.readableEnded, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
});

test("open-input run cancelled at confirmation exits 0 with no residual stdin listeners", async (t) => {
  const projectDir = makeTempDir("open-cancel");
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  const out = makeOutput();
  const input = new PassThrough();

  const runPromise = run(["install"], {
    input,
    output: out.stream,
    errorOutput: makeOutput().stream,
    isTTY: true,
    home: join(projectDir, "home"),
    cwd: projectDir,
    detect: () => makeHosts(),
  });
  input.write("1\n"); // target answer
  input.write("2\n"); // scope answer
  input.write("n\n"); // cancel at confirmation

  const exit = await runPromise;

  assert.equal(exit, 0);
  assert.match(out.text(), /Install cancelled; nothing was written\./);
  assert.equal(existsSync(join(projectDir, ".claude")), false);
  assert.equal(existsSync(join(projectDir, ".agents")), false);
  assert.equal(input.writableEnded, false);
  assert.equal(input.readableEnded, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("error"), 0);
});

test("--help exits 0 and documents both the explicit and interactive forms", async (t) => {
  const out = makeOutput();

  const exit = await run(["--help"], {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: makeOutput().stream,
  });

  assert.equal(exit, 0);
  const text = out.text();
  assert.match(text, /Usage:/);
  assert.match(text, /install --target <name>/);
  assert.match(text, /install\n/);
  assert.match(text, /Interactive/);
});
