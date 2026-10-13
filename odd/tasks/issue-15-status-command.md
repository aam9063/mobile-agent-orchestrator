# Issue #15 — Read-only `status` command

Issue: egdev6/mobile-agent-orchestrator#15 (blocked by #12, #13 — both merged).
Branch: `feat/issue-15-status-command` (create before first write; NO commits without explicit user approval — commit-approval-policy).

## Outcome

A read-only command reporting whether each target installation is absent, managed, outdated,
locally modified, or unknown.

## Acceptance criteria (from issue)

- `mobile-agent-orchestrator status` inspects every supported target without writing.
- `--target` limits inspection to one or more hosts.
- Statuses: `absent`, `managed`, `outdated`, `modified`, `unknown`.
- Managed status is based on the recorded version and file checksums.
- Partial installations and missing manifest files are reported safely.
- Exit codes for automation are documented.
- Tests cover every status and both user/project scopes.
- `npm test` succeeds.

## Design decisions

1. **Classification per unique destination** (reuses `resolveUniqueDestinations` so shared
   `.agents/skills` collapse, targets listed per destination), statuses in precedence order:
   - `absent` — skill directory does not exist.
   - `unknown` — directory exists but there is no valid manifest (partial install, corrupt /
     symlinked / non-regular manifest, or foreign content). Safe: never follows symlinks.
   - `modified` — valid manifest but a managed file's checksum mismatches or a managed file is
     missing.
   - `outdated` — all recorded checksums match on disk but the recorded `installerVersion`
     differs from the current package version (either direction).
   - `managed` — valid manifest, every recorded checksum matches, version equals current.
2. **No `--scope` required**: when omitted, both user and project destinations are inspected
   (issue verification shows bare `status`); `--scope user|project` narrows it.
3. **`--target` filters** (repeatable, same validation as install); default inspects all four
   write targets. Pi is not inspectable (no managed destination; detect-only per #14).
4. **Exit codes (documented)**: `0` = every inspected destination is `absent` or `managed`
   (nothing needs attention); `1` = any `outdated`, `modified`, or `unknown` destination; `1`
   also for usage/validation errors.
5. **Strictly read-only**: existence/stat checks and checksum reads only; reuses
   `inspectManifestPath`/`readManifestFile`/`listFiles` from installer.mjs; never follows
   symlinks, never writes.
6. Output: one line per destination `STATUS [scope] destination (targets)` plus indented detail
   lines (missing/modified file paths, manifest problems) for non-managed statuses.

## Tasks

- [x] T1 (test-first): `inspectInstallations({ targets, scopes, cwd, home, installerVersion })`
      in lib/installer.mjs (read-only classification above) + `tests/status.test.mjs` lib-level
      cases: every status, both scopes, partial install, missing/corrupt/symlinked manifest,
      missing managed file, version-only difference, --target filtering semantics at lib level.
  - Evidence: RED missing-export SyntaxError → GREEN 15/15 + 1 platform skip (symlink, Windows host); full suite 103 tests, 92 pass, 2 pre-existing fails, 9 skips. Uncommitted (+85 lib, tests/status.test.mjs new with 16 tests).
  - Decision: extra unmanaged files beside a fully matching manifest keep `managed`, listed in details (read-only-informational, not downgraded). Sub-case choice: manifest-recorded path that is a symlink/non-regular counts as `modified` with detail.
- [x] T2 (test-first): `status` subcommand in bin (`--target`, optional `--scope`, exit codes,
      usage text) + CLI-level tests with injected streams/args.
  - Evidence: RED `Unknown subcommand: status.` (6 CLI tests failing) → GREEN 22/22 + 1 platform skip; full suite 110 tests, 99 pass, 2 pre-existing fails, 9 skips. Uncommitted (bin +75/−5, tests/status.test.mjs 23 tests total).
  - Output: `STATUS [scope] destination (targets)` + `  - <detail>` lines + `N destination(s) inspected`. Exit 0 = all absent/managed; 1 = any outdated/modified/unknown or validation error. `--dry-run` rejected for status (`Unknown argument`). Zero-write proven with before/after `ls -R` on the real home.
- [x] T3: README documents the status command (statuses, exit codes, automation use).
  - Evidence: README.md gains a `#### Status` subsection after the installer section: commands, status semantics (incl. the unmanaged-files decision and Pi exclusion), and the exit-code contract. Uncommitted.
- [ ] T4: full verification (`npm test` baseline note, manual status runs incl. real
      user-scope read of this machine, zero-write proof), work-unit commits ON USER APPROVAL,
      push, PR to egdev6:main (Closes #15).

## Evidence log

(filled per task)

## Review round 1 (maintainer, status PR)

- P2 #1: intermediate directory symlinks were followed (final-component lstat only) — a symlinked `references/` let inspection read external files and report `managed` on matching checksums. Fix: `unsafeIntermediateComponent()` lstats every component between the skill directory and the recorded file; symlink/non-dir intermediate → per-file mismatch, detail `<file> (intermediate <name> is a symlink or not a directory)`, never read through. RED observed: junction fixture reported `managed` pre-fix.
- P2 #2: directory replaced by a regular file threw ENOTDIR (only ENOENT handled) and aborted the whole inspection. Fix: ENOTDIR (and the Windows-mapped ENOENT) degrades to a per-file mismatch; inspection continues with remaining destinations. Windows quirk documented: traversal through a file is ENOENT on win32, ENOTDIR on POSIX — the maintainer's abort only reproduces on Linux.
- Evidence: 2 new tests (junction-based, no new skips); suite 113 tests, 102 pass, 2 pre-existing fails, 9 skips. Committed with user approval: f859c0d (fix) + 1b645c6 (docs).

## Review round 2 (maintainer, status PR)

- P2: normalization bypass — manifest record `missing/../references/guide.md` (absent `missing`, symlinked `references` with matching content): `unsafeIntermediateComponent` stopped at the first ENOENT, `join()` normalized `missing/..` away, and the checksum read followed the symlink → `managed`. Fix: `isCanonicalRecordedPath` (non-empty, no backslash, not absolute, no empty/`.`/`..` segment) folded into the unsafeRecordedPaths filter → non-canonical or containment-violating records make the destination `unknown` with `(unsafe manifest path)` details. With canonical records guaranteed, join() normalizes nothing and the intermediate check validates exactly the read path. Install path verified safe by reading: writes are keyed by real listings (discoverPackageFiles/listFiles), never by manifest paths.
- Evidence: 2 new tests incl. the maintainer's exact junction reproduction (RED: `managed` pre-fix); suite 115 tests, 104 pass, 2 pre-existing fails, 9 skips. Committed with user approval: 9a86894 (fix) + fdc8949 (docs).

## Review round 3 (maintainer, status PR)

- P2: cyclic intermediate symlink (references -> references) — the caller ran the final `lstatSync(destinationPath)` before handling the unsafe-intermediate result; lstat traverses intermediate symlinks during path resolution, so the cyclic link threw ELOOP on POSIX and aborted the whole inspection (exit 1, no destinations reported). Fix: resolve the final component ONLY when `unsafeIntermediateComponent` returned null — a failed intermediate skips the lstat entirely and degrades to the per-file mismatch.
- RED caveat (honest): on this Windows host the cyclic junction does not throw at the final lstat (win32 resolves it without ELOOP), so the pre-fix abort was not locally reproducible — the POSIX ELOOP abort is the maintainer's reproduction at fdc8949. The fix is still strictly safer: the final lstat is never attempted through an unsafe intermediate. Regression test (cyclic junction + intact second destination) runs on all platforms and asserts 2 entries, `modified` + intermediate detail, other destination `managed`.
- Evidence: suite 116 tests, 105 pass, 2 pre-existing fails, 9 skips. Uncommitted pending user approval.

## Review self-check (pre-PR hardening)

- Found: `inspectInstallations` trusted manifest-recorded paths — a crafted manifest with `../outside.txt` drove lstat/sha256 reads outside the skill directory (read-only, but untrusted-input surface).
- Fix (test-first): RED showed `modified` (the escaped path was actually inspected) → GREEN after adding a resolve-containment guard: any recorded path resolving outside the skill directory makes the whole destination `unknown` with `unsafe manifest path` details, and no file is read for it. Test: `a manifest recording a path outside the skill directory is reported as unknown`.
- Suite after hardening: 111 tests, 100 pass, 2 pre-existing Windows detect-release fails, 9 skips.
