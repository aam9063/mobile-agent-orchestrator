import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { resolveDestination, resolveUniqueDestinations, targets } from "../lib/hosts.mjs";
import { buildPlan, discoverPackageFiles, executePlan, MANIFEST_NAME, sha256 } from "../lib/installer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = join(repoRoot, "skills", "mobile-agent-orchestrator");
const installerVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
const canonicalFiles = discoverPackageFiles(skillRoot);

function makeEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "installer-test-"));
  return {
    root,
    cwd: join(root, "project"),
    home: join(root, "home"),
    destination: join(root, "home", ".agents", "skills", "mobile-agent-orchestrator"),
    manifestPath: join(root, "home", ".agents", "skills", MANIFEST_NAME),
  };
}

function install(environment, { targets: selectedTargets = ["codex"], skillRoot: sourceRoot = skillRoot, ...executeOptions } = {}) {
  const plan = buildPlan({
    targets: selectedTargets,
    scope: "user",
    cwd: environment.cwd,
    home: environment.home,
    skillRoot: sourceRoot,
    installerVersion,
  });
  return { plan, result: executePlan(plan, executeOptions) };
}

test("clean install copies SKILL.md and every discovered reference", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const { result } = install(environment);
  assert.equal(result.status, "installed");
  assert.equal(result.writtenFiles.length, canonicalFiles.length + 1);
  for (const file of canonicalFiles) {
    const installedPath = join(environment.destination, ...file.path.split("/"));
    assert.ok(existsSync(installedPath), `missing installed file: ${file.path}`);
    assert.equal(readFileSync(installedPath, "utf8"), readFileSync(file.source, "utf8"));
    assert.ok(result.writtenFiles.includes(installedPath));
  }
});

test("manifest is written beside the skill directory with version and checksums", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const manifest = JSON.parse(readFileSync(environment.manifestPath, "utf8"));
  assert.equal(manifest.installerVersion, installerVersion);
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    canonicalFiles.map((file) => file.path),
  );
  for (const file of manifest.files) {
    const source = canonicalFiles.find((candidate) => candidate.path === file.path).source;
    assert.equal(file.sha256, sha256(readFileSync(source)));
  }
});

test("reinstalling identical content is an up-to-date no-op", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const skillBefore = readFileSync(join(environment.destination, "SKILL.md"), "utf8");
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");

  const { result } = install(environment);
  assert.equal(result.status, "up-to-date");
  assert.deepEqual(result.writtenFiles, []);
  assert.equal(readFileSync(join(environment.destination, "SKILL.md"), "utf8"), skillBefore);
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
});

test("reinstalling over a locally modified file aborts without writing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const modifiedSkillPath = join(environment.destination, "SKILL.md");
  writeFileSync(modifiedSkillPath, `${readFileSync(modifiedSkillPath, "utf8")}\nlocal edit\n`);
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("SKILL.md (modified)"));
  assert.match(readFileSync(modifiedSkillPath, "utf8"), /local edit/);
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
});

test("unmanaged destination content aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const extraPath = join(environment.destination, "references", "extra-notes.md");
  writeFileSync(extraPath, "user notes\n");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/extra-notes.md (unmanaged)"));
  assert.equal(readFileSync(extraPath, "utf8"), "user notes\n");
});

test("dry run writes nothing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const { plan, result } = install(environment, { dryRun: true });
  assert.equal(result.status, "installed");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(plan.destinations[0].files.every((file) => file.action === "create"));
  assert.ok(!existsSync(join(environment.home, ".agents")));

  install(environment);
  const manifestBefore = readFileSync(environment.manifestPath, "utf8");
  const rerun = install(environment, { dryRun: true });
  assert.equal(rerun.result.status, "up-to-date");
  assert.deepEqual(rerun.result.writtenFiles, []);
  assert.equal(readFileSync(environment.manifestPath, "utf8"), manifestBefore);
});

test("selecting all three targets yields one destination and one manifest", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  assert.deepEqual(
    resolveUniqueDestinations(targets, "user", { cwd: environment.cwd, home: environment.home }).map((entry) => entry.destination),
    [environment.destination],
  );

  const { plan, result } = install(environment, { targets });
  assert.equal(plan.destinations.length, 1);
  assert.deepEqual(plan.destinations[0].targets, ["codex", "opencode", "gemini"]);
  assert.equal(result.status, "installed");
  assert.ok(existsSync(environment.manifestPath));
  assert.equal(result.writtenFiles.filter((path) => path.endsWith(MANIFEST_NAME)).length, 1);
});

test("invalid target and invalid or missing scope fail with clear errors", () => {
  const options = { cwd: "/tmp/project", home: "/tmp/home" };
  assert.throws(() => resolveDestination("claude", "user", options), /Unknown target: "claude"/);
  assert.throws(() => resolveDestination("codex", "workspace", options), /Unknown scope: "workspace"/);
  assert.throws(() => resolveDestination("codex", "user", { cwd: "/tmp/project" }), /requires an explicit home directory/);
  assert.throws(() => resolveDestination("codex", "project", { home: "/tmp/home" }), /requires an explicit working directory/);
  assert.throws(
    () => resolveUniqueDestinations(["codex"], "user", {}),
    /requires an explicit home directory/,
  );
});

test("destinations are built with path.join semantics for both scopes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "installer-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { cwd: join(root, "project"), home: join(root, "home") };
  assert.equal(
    resolveDestination("codex", "user", options),
    join(options.home, ".agents", "skills", "mobile-agent-orchestrator"),
  );
  assert.equal(
    resolveDestination("gemini", "project", options),
    join(options.cwd, ".agents", "skills", "mobile-agent-orchestrator"),
  );
});

test("a corrupt manifest fails closed: reinstall aborts without writing", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  writeFileSync(environment.manifestPath, "{not valid json");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.some((conflict) => /corrupt manifest/.test(conflict)));
  assert.equal(readFileSync(environment.manifestPath, "utf8"), "{not valid json");
});

test("a deleted manifest is rewritten without touching identical installed files", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const skillBefore = readFileSync(join(environment.destination, "SKILL.md"), "utf8");
  rmSync(environment.manifestPath);

  const { result } = install(environment);
  assert.equal(result.status, "installed");
  assert.deepEqual(result.writtenFiles, [environment.manifestPath]);
  assert.equal(readFileSync(join(environment.destination, "SKILL.md"), "utf8"), skillBefore);
});

test("a broken symlink at a managed path aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const managedPath = join(environment.destination, "references", "platform-matrix.md");
  rmSync(managedPath);
  try {
    symlinkSync(join(environment.destination, "missing-target.md"), managedPath);
  } catch {
    return t.skip("symlinks unavailable on this platform");
  }

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/platform-matrix.md (unmanaged)"));
  assert.ok(lstatSync(managedPath).isSymbolicLink());
});

test("a destination skill path that is a regular file aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));
  mkdirSync(join(environment.home, ".agents", "skills"), { recursive: true });
  writeFileSync(environment.destination, "occupied");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.some((conflict) => /not a managed directory/.test(conflict)));
});

test("a nested unmanaged file aborts the install", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  install(environment);
  const nestedPath = join(environment.destination, "references", "nested", "extra.md");
  mkdirSync(dirname(nestedPath), { recursive: true });
  writeFileSync(nestedPath, "stray notes\n");

  const { result } = install(environment);
  assert.equal(result.status, "aborted");
  assert.deepEqual(result.writtenFiles, []);
  assert.ok(result.conflicts.includes("references/nested/extra.md (unmanaged)"));
});

test("a version update replaces managed content recorded by the previous manifest", (t) => {
  const environment = makeEnvironment();
  t.after(() => rmSync(environment.root, { recursive: true, force: true }));

  const fixtureRoot = join(environment.root, "fixture", "mobile-agent-orchestrator");
  cpSync(skillRoot, fixtureRoot, { recursive: true });
  install(environment, { skillRoot: fixtureRoot });

  const sourceSkillPath = join(fixtureRoot, "SKILL.md");
  writeFileSync(sourceSkillPath, `${readFileSync(sourceSkillPath, "utf8")}\n## New in this version\n`);

  const { plan, result } = install(environment, { skillRoot: fixtureRoot });
  assert.equal(result.status, "installed");
  const updated = plan.destinations[0].files.find((file) => file.path === "SKILL.md");
  assert.equal(updated.classification, "modified");
  assert.equal(updated.action, "replace");
  assert.deepEqual(readFileSync(join(environment.destination, "SKILL.md"), "utf8"), readFileSync(sourceSkillPath, "utf8"));
  assert.ok(result.writtenFiles.includes(environment.manifestPath));
});
