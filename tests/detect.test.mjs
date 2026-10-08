import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { HOST_CONFIG_DIRS, HOST_EXECUTABLES, detectHosts } from "../lib/detect.mjs";

const HOST_ORDER = ["pi", "claude-code", "codex", "opencode", "gemini"];

// PATH-scan tests that use real filesystem paths run against the host platform so PATH
// separators and executable fakes match the operating system (Windows paths contain a drive
// colon, which a simulated ":"-separated linux PATH would split incorrectly).
const isWindows = process.platform === "win32";
const pathSeparator = isWindows ? ";" : ":";
const fakeExecutable = (name) => (isWindows ? `${name}.cmd` : name);

/**
 * Write a regular file that qualifies as an executable on POSIX (owner/group/other exec bits).
 * chmodSync is a no-op for exec bits on Windows (regular file + extension is enough there), but
 * it is required on POSIX now that the PATH scan rejects non-executable files.
 */
function writeExecutable(directory, name) {
  const path = join(directory, name);
  writeFileSync(path, "");
  chmodSync(path, 0o755);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "detect-test-"));
  return {
    root,
    home: join(root, "home"),
    bin: join(root, "bin"),
  };
}

function makePathFixture(t) {
  const fixture = makeFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  mkdirSync(fixture.home, { recursive: true });
  mkdirSync(fixture.bin, { recursive: true });
  return fixture;
}

test("returns entries for all five hosts in canonical order", (t) => {
  const fixture = makePathFixture(t);
  const results = detectHosts({ home: fixture.home, pathEnv: "", platform: "linux" });
  assert.deepEqual(results.map((entry) => entry.id), HOST_ORDER);
  for (const entry of results) {
    assert.equal(entry.detected, false);
    assert.equal(entry.evidence, "");
  }
});

test("detects hosts by well-known config directories under home", (t) => {
  const fixture = makePathFixture(t);
  mkdirSync(join(fixture.home, ".pi"), { recursive: true });
  mkdirSync(join(fixture.home, ".claude"), { recursive: true });
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  mkdirSync(join(fixture.home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(fixture.home, ".gemini"), { recursive: true });

  const results = detectHosts({ home: fixture.home, pathEnv: "", platform: "linux" });
  const byId = new Map(results.map((entry) => [entry.id, entry]));
  for (const id of HOST_ORDER) {
    assert.equal(byId.get(id).detected, true, `${id} should be detected via config dir`);
    assert.match(byId.get(id).evidence, /config dir ~\//);
  }
  assert.match(byId.get("claude-code").evidence, /~\/\.claude/);
  assert.match(byId.get("opencode").evidence, /~\/\.config\/opencode/);
});

test("opencode is detected through its alternative ~/.opencode directory", (t) => {
  const fixture = makePathFixture(t);
  mkdirSync(join(fixture.home, ".opencode"), { recursive: true });

  const results = detectHosts({ home: fixture.home, pathEnv: "", platform: "linux" });
  const opencode = results.find((entry) => entry.id === "opencode");
  assert.equal(opencode.detected, true);
  assert.match(opencode.evidence, /~\/\.opencode/);
});

test("detects extensionless executables in PATH on non-windows platforms", (t) => {
  const fixture = makePathFixture(t);
  writeExecutable(fixture.bin, "codex");
  // A Windows host cannot represent POSIX exec bits (chmod only toggles the read-only flag), so
  // the exec-bit-qualified extensionless scan is only observable on POSIX hosts; the win32-mode
  // positive is covered by "an executable regular file is still detected in PATH".
  if ((statSync(join(fixture.bin, "codex")).mode & 0o111) === 0) {
    return t.skip("host filesystem cannot represent POSIX executable bits");
  }
  // Relative entry avoids the Windows drive colon, which a ":"-separated PATH would split.
  const pathEnv = relative(process.cwd(), fixture.bin);

  const results = detectHosts({ home: fixture.home, pathEnv, platform: "linux" });
  const codex = results.find((entry) => entry.id === "codex");
  assert.equal(codex.detected, true);
  assert.match(codex.evidence, /found in PATH/);

  const others = results.filter((entry) => entry.id !== "codex");
  for (const entry of others) {
    assert.equal(entry.detected, false, `${entry.id} should not be detected`);
  }
});

test("detects windows executable extensions (.exe, .cmd, .bat) on win32", (t) => {
  const fixture = makePathFixture(t);
  writeFileSync(join(fixture.bin, "claude.exe"), "");
  writeFileSync(join(fixture.bin, "gemini.cmd"), "");
  writeFileSync(join(fixture.bin, "opencode.bat"), "");

  const results = detectHosts({ home: fixture.home, pathEnv: fixture.bin, platform: "win32" });
  const byId = new Map(results.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("claude-code").detected, true);
  assert.equal(byId.get("gemini").detected, true);
  assert.equal(byId.get("opencode").detected, true);
});

test("extensionless executables are ignored on win32", (t) => {
  const fixture = makePathFixture(t);
  writeFileSync(join(fixture.bin, "claude"), "");

  const results = detectHosts({ home: fixture.home, pathEnv: fixture.bin, platform: "win32" });
  const claudeCode = results.find((entry) => entry.id === "claude-code");
  assert.equal(claudeCode.detected, false);
});

test("PATH entries that do not exist or are files are skipped without throwing", (t) => {
  const fixture = makePathFixture(t);
  const fileEntry = join(fixture.root, "not-a-directory");
  writeFileSync(fileEntry, "");
  const missing = join(fixture.root, "does-not-exist");
  writeExecutable(fixture.bin, fakeExecutable("pi"));

  const pathEnv = `${pathSeparator}${pathSeparator}${missing}${pathSeparator}${fileEntry}${pathSeparator}${fixture.bin}${pathSeparator}`;
  const results = detectHosts({ home: fixture.home, pathEnv, platform: process.platform });
  const pi = results.find((entry) => entry.id === "pi");
  assert.equal(pi.detected, true);
});

test("a directory named like an executable is not detected as installed", (t) => {
  const fixture = makePathFixture(t);
  // A directory that merely shares the executable's name must never count as "found in PATH".
  mkdirSync(join(fixture.bin, "codex"), { recursive: true });

  // Relative entry avoids the Windows drive colon, which a ":"-separated PATH would split.
  const pathEnv = relative(process.cwd(), fixture.bin);
  const results = detectHosts({ home: fixture.home, pathEnv, platform: "linux" });
  const codex = results.find((entry) => entry.id === "codex");
  assert.equal(codex.detected, false);
  assert.equal(codex.evidence, "");
});

test("a regular file without executable bits is not detected on POSIX", (t) => {
  const fixture = makePathFixture(t);
  // Files created with default modes carry no exec bits on any platform, so this fixture is a
  // valid non-executable regular file on both Windows and POSIX hosts.
  writeFileSync(join(fixture.bin, "codex"), "");

  const pathEnv = relative(process.cwd(), fixture.bin);
  const results = detectHosts({ home: fixture.home, pathEnv, platform: "linux" });
  const codex = results.find((entry) => entry.id === "codex");
  assert.equal(codex.detected, false);
  assert.equal(codex.evidence, "");
});

test("an executable regular file is still detected in PATH", (t) => {
  const fixture = makePathFixture(t);
  writeExecutable(fixture.bin, fakeExecutable("gemini"));

  // Host platform: on POSIX the exec bits qualify the file; on win32 a regular file with an
  // executable extension is enough (the extension already implies executability).
  const results = detectHosts({ home: fixture.home, pathEnv: fixture.bin, platform: process.platform });
  const gemini = results.find((entry) => entry.id === "gemini");
  assert.equal(gemini.detected, true);
  assert.match(gemini.evidence, /found in PATH/);
});

test("combines config-dir and PATH evidence for the same host", (t) => {
  const fixture = makePathFixture(t);
  mkdirSync(join(fixture.home, ".codex"), { recursive: true });
  writeExecutable(fixture.bin, fakeExecutable("codex"));

  const results = detectHosts({ home: fixture.home, pathEnv: fixture.bin, platform: process.platform });
  const codex = results.find((entry) => entry.id === "codex");
  assert.match(codex.evidence, /config dir ~\/\.codex/);
  assert.match(codex.evidence, /found in PATH/);
});

test("missing options fall back to defaults without throwing", () => {
  const results = detectHosts();
  assert.deepEqual(results.map((entry) => entry.id), HOST_ORDER);
  for (const entry of results) {
    assert.equal(typeof entry.detected, "boolean");
    assert.equal(typeof entry.evidence, "string");
  }
});

test("detection never modifies the filesystem", (t) => {
  const fixture = makePathFixture(t);
  detectHosts({ home: fixture.home, pathEnv: fixture.bin, platform: "win32" });
  for (const candidates of Object.values(HOST_CONFIG_DIRS)) {
    for (const candidate of candidates) {
      assert.equal(existsSync(join(fixture.home, ...candidate.split("/"))), false, `probe created ~/${candidate}`);
    }
  }
});

test("exports executable names and config-dir candidates for reuse", () => {
  assert.deepEqual(HOST_EXECUTABLES, {
    pi: "pi",
    "claude-code": "claude",
    codex: "codex",
    opencode: "opencode",
    gemini: "gemini",
  });
  assert.deepEqual(HOST_CONFIG_DIRS["opencode"], [".config/opencode", ".opencode"]);
  assert.deepEqual(HOST_CONFIG_DIRS["pi"], [".pi"]);
});
