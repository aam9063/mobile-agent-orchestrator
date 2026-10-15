# Issue #16 — `uninstall`: safe removal of installer-managed copies

Issue: egdev6/mobile-agent-orchestrator#16 (blocked by #15 — merged as 9e01555).
Branch: `feat/issue-16-uninstall` (create before first write; NO commits without explicit user approval — commit-approval-policy).
Goal from the user: leave the PR as clean as possible — bake the adversarial-review classes (symlinks, normalization, containment) into the design, and run an internal adversarial pass before opening the PR.

## Specs

Quoting the issue verbatim:

- S1: "`mobile-agent-orchestrator uninstall --target <host>` removes only files recorded in the installer manifest."
- S2: "Locally modified managed files block deletion and produce a clear explanation."
- S3: "Unmanaged files and directories are never removed."
- S4: "Empty directories created exclusively by the installer may be cleaned up."
- S5: "`--dry-run` reports the exact deletion plan without writing."
- S6: "The source skill and Pi-installed npm package are never removed."
- S7: "Tests cover clean, modified, partial, unknown, and shared-destination installations."
- S8: "`npm test` succeeds."
- S9 (non-goals, verbatim): "Uninstalling coding-agent CLIs, Herdr, Moshi, network tooling, or system services. / Force-deleting modified user content. / npm publication."

## Design decisions

1. **Two-phase, plan/execute mirror of install**: `buildUninstallPlan({ targets, scopes, cwd, home })`
   (pure classification, zero writes) + `executeUninstallPlan(plan, { dryRun })` (the only writer).
   Same destination resolution as install/status (`resolveUniqueDestinations`; shared
   `.agents/skills` collapse, targets reported per destination — S7 shared-destination case).
2. **Removal candidates come from the real listing, never from manifest paths** (the #26 lesson):
   walk the destination with the non-following `listFiles`, compute relative paths, and a file is
   removable only when its relative path is recorded in the manifest AND its sha256 matches the
   record. Manifest paths never drive a deletion target directly.
3. **Manifest trust = same bar as status**: manifest must be a regular file (`inspectManifestPath`),
   schema-valid (`readManifestFile`), and every recorded path canonical + contained
   (`isCanonicalRecordedPath` + resolve-containment, reused from #29). Anything else → the
   destination is `unknown` → refuse (S2/S3 safety, "reported safely" spirit).
4. **Blocked classifications** (never removed, always explained — S2/S3):
   - recorded path whose on-disk checksum differs → `modified` (blocks the whole destination:
     removal is all-or-nothing per destination, mirroring install's conflict abort);
   - recorded path that is a symlink or non-regular → block with detail;
   - intermediate component of a recorded path that is a symlink or non-directory → block, never
     resolve through it (the #29 lesson: check intermediates BEFORE touching anything);
   - files not in the manifest → `unmanaged`, preserved, listed in details (S3).
   - recorded-but-absent files are NOT a block: a partial installation (S7) proceeds for what
     still matches; missing files are reported as already gone.
5. **Directory cleanup (S4)**: after file removals, directories on recorded-file paths that became
   empty are removed bottom-up, stopping at (and never removing) the scope base's `skills`
   directory level — the skill directory itself is removed only when empty. A directory kept
   non-empty by unmanaged content is left alone (S3). The manifest file is removed after its
   files, and the skill directory only if it ended empty.
6. **CLI**: `uninstall --target <name> [--target ...] [--scope <user|project>] [--dry-run]`.
   `--target` required (S1, exact install validation messages); `--scope` optional, defaults to
   BOTH scopes (matches the issue's verification form `uninstall --target codex --dry-run` and the
   status convention; each destination is reported per scope so nothing is ambiguous). Exit codes
   documented like status: `0` = every destination uninstalled or already absent; `1` = any
   blocked/unknown destination or usage error. No interactive flow (destructive command +
   non-goal S9 conservatism); `--dry-run` is the safety net (S5).
7. **Never removed, ever (S6/S9)**: the package source (`skillRoot`) is not even an input to the
   uninstall plan; nothing outside destination skill directories + their manifest + their empty
   recorded-path directories is touched. Pi/npm packages are not destinations of this installer.
8. **Dry-run (S5)**: prints the same plan structure the write would use, zero writes (snapshot
   assertion in tests, as in #15).

## Adversarial hardening (baked in from design, per the 4 findings of PR #29)

- Canonical + containment gate before any path use (round-2 finding).
- Per-component intermediate check before any unlink; never resolve through a symlink (round-1
  and round-3 findings).
- Only ENOENT/ENOTDIR-aware classification; one broken destination never aborts the report or the
  removal of others (round-1 finding 2, round-3 finding).
- Removals and directory cleanup keyed by real listing paths only.
- Internal adversarial pass (subagent) reproducing symlink/normalization attacks BEFORE the PR.

## Tasks

- [x] T1 (test-first): `buildUninstallPlan` + `executeUninstallPlan` in lib/installer.mjs +
      `tests/uninstall.test.mjs` lib-level: clean, modified-blocks, unmanaged-preserved, partial,
      unknown (missing/corrupt/symlinked manifest, unsafe paths), shared destination, empty-dir
      cleanup, symlinked final/intermediate components, dry-run zero-write snapshot.
  - Evidence: RED missing-export → GREEN 14/14 + 2 platform skips; full suite 132 tests, 119 pass, 2 pre-existing fails, 11 skips. Uncommitted (+266 lib, tests/uninstall.test.mjs new with 16 tests).
  - Recorded decisions: unmanaged never blocks (S3) but is listed; all-or-nothing per destination (blocked → zero removals, no dir cleanup, no manifest removal); directory cleanup static-computed to end empty, bottom-up, ENOTEMPTY/ENOENT = skip; skill dir removed only when nothing survives. Extra: case-insensitive recorded-name alias blocks so the manifest is never removed orphaning managed content. execute pre-verifies everything + re-lstat immediately before each unlink.
- [x] T2 (test-first): `uninstall` subcommand in bin (validation identical to install, both-scope
      default, exit codes, usage text) + CLI-level tests.
  - Evidence: RED 7 CLI tests failing (`Unknown subcommand: uninstall.`) → GREEN 21/21 + 2 platform skips (file total 23 tests); full suite 139 tests, 126 pass, 2 pre-existing fails, 11 skips. Uncommitted (bin +112/−4).
  - CLI-only addition: `expandSharedTargets` — `uninstall --target codex` plans/removes the single shared `.agents/skills` copy and reports `(codex, opencode, gemini)` on its line (the copy is atomic; documented in usage). Output: `STATUS [scope] destination (targets)` + `  - remove/keep/detail` lines + summary; exit 0 = all uninstalled/absent, 1 = any blocked/unknown or validation error.
- [x] T3: README documents uninstall (semantics, blocking, exit codes).
  - Evidence: README.md gains `#### Uninstall` after the Status section: commands, removal semantics (checksum-verified manifest records only, unmanaged kept, blocking, unknown refusal, shared-copy behavior, both-scopes default), `--dry-run`, exit codes, non-interactivity, and the S6 guarantee (source skill and Pi copies never touched). Uncommitted.
- [ ] T4: internal adversarial review pass; full verification; commits ON USER APPROVAL; PR.

## Evidence log

(filled per task)

## Adversarial pass (internal, before PR) — jd-judge-a

8 findings, all fixed test-first where RED was reproducible on this host:

- F1 P1 (live-reproduced): execution-time re-check did not re-validate intermediates — swapping `references` for a junction after planning made `executeUninstallPlan` unlink an external victim file. Fix: `verifyRemovalCandidate()` re-runs `unsafeIntermediateComponent` + final lstat + checksum immediately before EACH unlink (pre-verify AND execution loop). RED: pre-fix reported `uninstalled` and deleted the victim.
- F2 P2 (live-reproduced): execution-time lstat throws aborted the whole destination loop (second clean destination abandoned). Fix: per-destination try/catch → refuse that destination, continue with the rest.
- F3 P2 (live-reproduced): checksum verified at plan time only — post-plan modification was deleted anyway. Fix: sha256 re-verified against the recorded checksum before each unlink.
- F5 P3: execution reordered to files → directories → manifest LAST (the manifest removal is the commit point); ENOENT on manifest unlink = skip. Re-run now converges after any partial failure.
- F4/F6/F7/F8 P3: honest docstring (pre-verification covers all but races; mid-loop races stop the destination and report exactly what was removed); renderUninstallPlan shows informational details for clean destinations; real-listing lstat ENOENT → already absent; `inspectManifestPath` ENOTDIR → absent (shared helper).
- Residual normalization (parent-applied inline after the writer flagged it): the skill-directory lstat in `classifyUninstallDestination` and `inspectInstallations` also treats ENOTDIR as absent — a non-directory ancestor of the destination cannot host a managed installation.
- 11 attacks failed (documented): canonical/containment gates, NTFS aliasing incl. ADS + trailing dot, directory-cleanup containment, partial-failure convergence, expandSharedTargets abuse, zero-write dry-run at all levels.
- Suite after hardening: 146 tests, 133 pass, 2 pre-existing Windows detect-release fails, 11 skips.
