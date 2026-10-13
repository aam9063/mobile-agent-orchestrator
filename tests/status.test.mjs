import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { run } from "../bin/mobile-agent-orchestrator.mjs";
import { buildPlan, executePlan, inspectInstallations, MANIFEST_NAME } from "../lib/installer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

/** A small synthetic skill source tree, independent of the repository's real skill. */
const fixtureFiles = {
  "SKILL.md": "# fixture skill\n\nGenerated for status tests.\n",
  "references/notes.md": "fixture notes\n",
};

/** Write a synthetic skill source tree (map of forward-slash path -> content). */
function writeSkillFixture(directory, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function makeEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "status-test-"));
  const environment = {
    root,
    cwd: join(root, "project"),
    home: join(root, "home"),
    skillRoot: join(root, "fixture-skill"),
  };
  mkdirSync(environment.cwd, { recursive: true });
  mkdirSync(environment.home, { recursive: true });
  writeSkillFixture(environment.skillRoot, fixtureFiles);
  return environment;
}

/** Install the fixture skill through the real plan builder so fixtures are genuine managed installations. */
function installFixture(environment, { targets: selectedTargets = ["codex"], scope = "user", installerVersion: version = installerVersion } = {}) {
  const plan = buildPlan({
    targets: selectedTargets,
    scope,
    cwd: environment.cwd,
    home: environment.home,
    skillRoot: environment.skillRoot,
    installerVersion: version,
  });
  return executePlan(plan);
}

/** Snapshot every path (relative, forward slashes, sorted) under a directory without following symlinks. */
function snapshotTree(directory) {
  const paths = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      paths.push(relative(directory, path).replaceAll(sep, "/"));
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  if (existsSync(directory)) visit(directory);
  return paths.sort();
}

function inspect(environment, { targets: selectedTargets = ["codex"], scopes: selectedScopes = ["user"] } = {}) {
  return inspectInstallations({
    targets: selectedTargets,
    scopes: selectedScopes,
    cwd: environment.cwd,
    home: environment.home,
    installerVersion,
  });
}

test("absent destination is reported without details", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const entries = inspect(environment);
  assert.deepEqual(entries, [{
    status: "absent",
    scope: "user",
    destination: join(environment.home, ".agents", "skills", "mobile-agent-orchestrator"),
    manifestPath: join(environment.home, ".agents", "skills", MANIFEST_NAME),
    targets: ["codex"],
    manifestVersion: null,
    details: [],
  }]);
});

test("matching managed installation is reported as managed with no details", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const [entry] = inspect(environment);
  assert.equal(entry.status, "managed");
  assert.equal(entry.scope, "user");
  assert.equal(entry.manifestVersion, installerVersion);
  assert.deepEqual(entry.details, []);
});

test("version-only difference in the manifest is reported as outdated", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { installerVersion: "0.0.1-fixture" });
  const [entry] = inspect(environment);
  assert.equal(entry.status, "outdated");
  assert.equal(entry.manifestVersion, "0.0.1-fixture");
  assert.deepEqual(entry.details, []);
});

test("an edited managed file is reported as modified and the detail names the file", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  writeFileSync(join(environment.home, ".agents", "skills", "mobile-agent-orchestrator", "SKILL.md"), "locally edited\n");
  const [entry] = inspect(environment);
  assert.equal(entry.status, "modified");
  assert.ok(entry.details.some((detail) => detail.includes("SKILL.md")));
});

test("a missing managed file is reported as modified and the detail names the file", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = join(environment.home, ".agents", "skills", "mobile-agent-orchestrator");
  unlinkSync(join(destination, "references", "notes.md"));
  const [entry] = inspect(environment);
  assert.equal(entry.status, "modified");
  assert.ok(entry.details.some((detail) => detail.includes("references/notes.md")));
});

test("an intermediate symlinked directory is never followed: matching external content is not managed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const destination = join(environment.home, ".agents", "skills", "mobile-agent-orchestrator");
  const notesPath = join(destination, "references", "notes.md");
  const originalContent = readFileSync(notesPath, "utf8");
  const externalDirectory = join(environment.root, "external-references");
  mkdirSync(externalDirectory, { recursive: true });
  writeFileSync(join(externalDirectory, "notes.md"), originalContent);
  rmSync(join(destination, "references"), { recursive: true });
  try {
    // "junction" needs no symlink privilege on Windows and is ignored on POSIX, where a real
    // directory symlink is created; lstat reports both as symbolic links.
    symlinkSync(externalDirectory, join(destination, "references"), "junction");
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }
  const [entry] = inspect(environment);
  assert.equal(
    entry.status,
    "modified",
    "a symlinked intermediate must never let matching external content report as managed",
  );
  const detail = entry.details.find((line) => line.includes("references/notes.md"));
  assert.ok(detail, `expected a detail naming the recorded file, got: ${JSON.stringify(entry.details)}`);
  assert.match(detail, /intermediate/, "the detail must name the offending intermediate");
});

test("a recorded child under an intermediate that became a regular file is a mismatch and other destinations still report", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex"], scope: "user" });
  installFixture(environment, { targets: ["claude-code"], scope: "user" });
  const codexDestination = join(environment.home, ".agents", "skills", "mobile-agent-orchestrator");
  rmSync(join(codexDestination, "references"), { recursive: true });
  writeFileSync(join(codexDestination, "references"), "now a regular file\n");

  const entries = inspect(environment, { targets: ["codex", "claude-code"] });
  assert.equal(entries.length, 2, "one broken destination must not abort the whole inspection");
  const broken = entries.find((entry) => entry.destination === codexDestination);
  assert.equal(broken.status, "modified");
  const brokenDetail = broken.details.find((detail) => detail.includes("references/notes.md"));
  assert.ok(brokenDetail, `expected a detail naming the child path, got: ${JSON.stringify(broken.details)}`);
  assert.match(brokenDetail, /intermediate/, "the detail must name the offending intermediate");
  const other = entries.find((entry) => entry.destination !== codexDestination);
  assert.equal(other.status, "managed", "the untouched destination must still be inspected normally");
});

test("a partial installation (some files, no manifest) is reported as unknown", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const destination = join(environment.home, ".agents", "skills", "mobile-agent-orchestrator");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "SKILL.md"), "foreign partial content\n");
  const [entry] = inspect(environment);
  assert.equal(entry.status, "unknown");
  assert.equal(entry.manifestVersion, null);
  assert.ok(entry.details.length > 0);
});

test("a full skill directory with a missing manifest is reported as unknown", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const destination = join(environment.home, ".agents", "skills", "mobile-agent-orchestrator");
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(environment.skillRoot, destination, { recursive: true });
  const [entry] = inspect(environment);
  assert.equal(entry.status, "unknown");
  assert.equal(entry.manifestVersion, null);
  assert.ok(entry.details.length > 0);
});

test("a corrupt manifest is reported as unknown", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  writeFileSync(join(environment.home, ".agents", "skills", MANIFEST_NAME), "{ not json");
  const [entry] = inspect(environment);
  assert.equal(entry.status, "unknown");
  assert.equal(entry.manifestVersion, null);
  assert.ok(entry.details.length > 0);
});

test("a manifest recording a path outside the skill directory is reported as unknown", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const manifestPath = join(environment.home, ".agents", "skills", MANIFEST_NAME);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.push({ path: "../outside.txt", sha256: "0".repeat(64) });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const [entry] = inspect(environment);
  assert.equal(entry.status, "unknown");
  assert.ok(
    entry.details.some((detail) => detail.includes("../outside.txt")),
    `expected an unsafe-path detail, got: ${JSON.stringify(entry.details)}`,
  );
});

test("a symlinked manifest is reported as unknown and never followed", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  const externalManifest = join(environment.root, "external-manifest.json");
  writeFileSync(externalManifest, JSON.stringify({ installerVersion, files: [] }, null, 2));
  const manifestPath = join(environment.home, ".agents", "skills", MANIFEST_NAME);
  unlinkSync(manifestPath);
  try {
    symlinkSync(externalManifest, manifestPath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }
  const [entry] = inspect(environment);
  assert.equal(entry.status, "unknown", "a valid symlinked manifest must still be unknown");
  assert.equal(entry.manifestVersion, null);
  assert.ok(entry.details.length > 0);
});

test("a skill path that exists but is not a real directory is reported as unknown", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const skillsDirectory = join(environment.home, ".agents", "skills");
  mkdirSync(skillsDirectory, { recursive: true });
  writeFileSync(join(skillsDirectory, "mobile-agent-orchestrator"), "not a directory\n");
  const [entry] = inspect(environment);
  assert.equal(entry.status, "unknown");
  assert.ok(entry.details.length > 0);
});

test("extra unmanaged files beside a fully matching manifest keep status managed with a detail line", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment);
  writeFileSync(join(environment.home, ".agents", "skills", "mobile-agent-orchestrator", "user-notes.md"), "unmanaged\n");
  const [entry] = inspect(environment);
  assert.equal(entry.status, "managed", "the decision: extra unmanaged files do not downgrade a matching install");
  assert.equal(entry.manifestVersion, installerVersion);
  assert.ok(entry.details.some((detail) => detail.includes("user-notes.md")));
});

test("both scopes are inspected with user first and project destinations resolved", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { scope: "user" });
  installFixture(environment, { scope: "project" });

  const entries = inspect(environment, { scopes: ["user", "project"] });
  assert.deepEqual(entries.map((entry) => entry.scope), ["user", "project"]);
  assert.equal(entries[0].status, "managed");
  assert.equal(entries[1].status, "managed");
  assert.equal(entries[1].destination, join(environment.cwd, ".agents", "skills", "mobile-agent-orchestrator"));
});

test("targets sharing one destination collapse with every target listed on the entry", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex", "opencode", "gemini"], scope: "user" });
  const [entry] = inspect(environment, { targets: ["codex", "opencode", "gemini", "claude-code"] });
  assert.deepEqual(entry.targets, ["codex", "opencode", "gemini"]);
  const claudeEntry = inspect(environment, { targets: ["claude-code"] })[0];
  assert.equal(claudeEntry.status, "absent", "claude-code uses its own .claude/skills destination");
  assert.deepEqual(claudeEntry.targets, ["claude-code"]);
});

test("target filtering narrows inspection to the selected targets only", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["claude-code"], scope: "user" });
  const codexOnly = inspect(environment, { targets: ["codex"] });
  assert.equal(codexOnly.length, 1);
  assert.equal(codexOnly[0].status, "absent");
  const claudeOnly = inspect(environment, { targets: ["claude-code"] });
  assert.equal(claudeOnly.length, 1);
  assert.equal(claudeOnly[0].status, "managed");
});

test("inspection is strictly read-only: the filesystem snapshot is unchanged", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { scope: "user" });
  installFixture(environment, { scope: "project" });
  writeFileSync(join(environment.home, ".agents", "skills", "mobile-agent-orchestrator", "user-notes.md"), "unmanaged\n");

  const before = snapshotTree(environment.root);
  inspect(environment, { scopes: ["user", "project"] });
  assert.deepEqual(snapshotTree(environment.root), before);
});

test("statuses reflect on-disk state after inspection runs (ordering and mixed statuses)", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { scope: "user", installerVersion: "0.0.1-fixture" });
  installFixture(environment, { scope: "project" });
  const projectDestination = join(environment.cwd, ".agents", "skills", "mobile-agent-orchestrator");
  writeFileSync(join(projectDestination, "SKILL.md"), "locally edited\n");

  const entries = inspect(environment, { scopes: ["user", "project"] });
  assert.deepEqual(entries.map((entry) => [entry.scope, entry.status]), [
    ["user", "outdated"],
    ["project", "modified"],
  ]);
});

// --- CLI-level tests: the `status` subcommand (issue #15 T2) ---

/** Writable stream that records every chunk synchronously, for deterministic output asserts. */
function makeOutput() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join(""), lines: () => chunks.join("").split("\n").filter((line) => line.length > 0) };
}

function statusRun(environment, argv) {
  const out = makeOutput();
  const err = makeOutput();
  const runPromise = run(argv, {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: err.stream,
    home: environment.home,
    cwd: environment.cwd,
  });
  return { exitPromise: runPromise, out, err };
}

const allTargets = ["codex", "opencode", "gemini", "claude-code"];

test("CLI status with no arguments inspects both scopes and exits 0 when everything is managed", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: allTargets, scope: "user" });
  installFixture(environment, { targets: allTargets, scope: "project" });

  const { exitPromise, out, err } = statusRun(environment, ["status"]);
  const exit = await exitPromise;

  assert.equal(exit, 0);
  const lines = out.lines();
  const userShared = join(environment.home, ".agents", "skills", "mobile-agent-orchestrator");
  const userClaude = join(environment.home, ".claude", "skills", "mobile-agent-orchestrator");
  const projectShared = join(environment.cwd, ".agents", "skills", "mobile-agent-orchestrator");
  const projectClaude = join(environment.cwd, ".claude", "skills", "mobile-agent-orchestrator");
  assert.deepEqual(lines, [
    `managed [user] ${userShared} (codex, opencode, gemini)`,
    `managed [user] ${userClaude} (claude-code)`,
    `managed [project] ${projectShared} (codex, opencode, gemini)`,
    `managed [project] ${projectClaude} (claude-code)`,
    "4 destination(s) inspected",
  ]);
  assert.equal(err.text(), "");
});

test("CLI status --target codex --scope project prints only the matching entry", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex"], scope: "user" });
  installFixture(environment, { targets: ["codex"], scope: "project" });

  const { exitPromise, out } = statusRun(environment, ["status", "--target", "codex", "--scope", "project"]);
  const exit = await exitPromise;

  assert.equal(exit, 0);
  assert.deepEqual(out.lines(), [
    `managed [project] ${join(environment.cwd, ".agents", "skills", "mobile-agent-orchestrator")} (codex)`,
    "1 destination(s) inspected",
  ]);
});

test("CLI status reports a modified installation with exit 1 and a detail line naming the file", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: ["codex"], scope: "user" });
  writeFileSync(join(environment.home, ".agents", "skills", "mobile-agent-orchestrator", "SKILL.md"), "locally edited\n");

  const { exitPromise, out } = statusRun(environment, ["status", "--target", "codex", "--scope", "user"]);
  const exit = await exitPromise;

  assert.equal(exit, 1, "a locally modified managed file needs attention");
  const lines = out.lines();
  assert.ok(lines[0].startsWith(`modified [user] ${join(environment.home, ".agents", "skills", "mobile-agent-orchestrator")} (codex)`));
  const detail = lines.find((line) => line.startsWith("  - "));
  assert.ok(detail, "an indented detail line is printed");
  assert.ok(detail.includes("SKILL.md"));
});

test("CLI status over an absent destination exits 0: absent is not attention-worthy", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const { exitPromise, out } = statusRun(environment, ["status", "--target", "codex", "--scope", "user"]);
  const exit = await exitPromise;

  assert.equal(exit, 0, "an absent destination must not fail the automation contract");
  assert.deepEqual(out.lines(), [
    `absent [user] ${join(environment.home, ".agents", "skills", "mobile-agent-orchestrator")} (codex)`,
    "1 destination(s) inspected",
  ]);
});

test("CLI status reuses the exact install validation messages and exits 1", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const cases = [
    { argv: ["status", "--target", "bogus"], message: /Unknown target: bogus\. Expected one of: codex, opencode, gemini, claude-code\./ },
    { argv: ["status", "--target"], message: /--target requires a value\./ },
    { argv: ["status", "--scope", "root"], message: /Unknown scope: root\. Expected one of: user, project\./ },
    { argv: ["status", "--scope"], message: /--scope requires a value\./ },
    { argv: ["status", "--nope"], message: /Unknown argument: --nope\./ },
    { argv: ["status", "--dry-run"], message: /Unknown argument: --dry-run\./ },
  ];
  for (const { argv, message } of cases) {
    const { exitPromise, err } = statusRun(environment, argv);
    const exit = await exitPromise;
    assert.equal(exit, 1, `expected exit 1 for ${argv.join(" ")}`);
    assert.match(err.text(), message);
  }
});

test("CLI status is strictly read-only: the fixture tree is byte-identical before and after", async (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  installFixture(environment, { targets: allTargets, scope: "user" });
  installFixture(environment, { targets: allTargets, scope: "project" });
  writeFileSync(join(environment.home, ".agents", "skills", "mobile-agent-orchestrator", "user-notes.md"), "unmanaged\n");

  const before = snapshotTree(environment.root);
  const { exitPromise } = statusRun(environment, ["status"]);
  await exitPromise;
  assert.deepEqual(snapshotTree(environment.root), before);
});

test("top-level --help documents the status command and its exit codes", async (t) => {
  const out = makeOutput();

  const exit = await run(["--help"], {
    input: Readable.from([]),
    output: out.stream,
    errorOutput: makeOutput().stream,
  });

  assert.equal(exit, 0);
  const text = out.text();
  assert.ok(text.includes("status [--target <name>]... [--scope <user|project>]"));
  assert.match(text, /read-only/);
  assert.match(text, /absent or managed/);
  assert.match(text, /outdated, modified, or unknown/);
});
