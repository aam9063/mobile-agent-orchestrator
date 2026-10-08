# Issue #14 — Interactive no-arguments install experience

Issue: egdev6/mobile-agent-orchestrator#14 (blocked by #12, #13 — both merged: PR #26 fe19cb1, PR #27 8bb055a).
Branch: `feat/issue-14-interactive-install` (create before first commit — lesson from #13).

## Outcome

`npx mobile-agent-orchestrator install` with no arguments detects available coding-agent CLIs and
asks the user which targets to configure. Explicit flags keep working for CI/automation.

## Acceptance criteria (from issue)

- Detects Pi, Claude Code, Codex, OpenCode, Gemini CLI without modifying them (read-only).
- Presents detected hosts and supported destinations before writing.
- Allows selecting one or multiple targets.
- Deduplicates shared `.agents/skills` destinations (already handled by `resolveUniqueDestinations`).
- Preserves explicit non-interactive flags (`--target`, `--scope`, `--dry-run`) for CI.
- Cancellation performs no writes.
- Pi detection prints the supported `pi install npm:...` command; Pi is never a write target.
- The installer never installs Herdr, Moshi, SSH, Mosh, Tailscale, services, or firewall rules.
- Interactive behavior has deterministic tests through injected input/output streams.
- `npm test` succeeds.

## Design decisions

1. **Detection is read-only, no process spawning**: check well-known config directories
   (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.config/opencode` or `~/.opencode`, Pi config) plus
   a PATH scan for the CLI executable (platform-aware extensions). New `lib/detect.mjs`, fully
   injectable (paths + PATH via options) for deterministic tests.
2. **Pi is detect-only**: listed with its `pi install npm:mobile-agent-orchestrator` command;
   never added to selectable write targets.
3. **Interactive flow** (only when no `--target` given and stdin is a TTY, via injected streams):
   show detected/undetected hosts with destinations → multi-select targets → select scope
   (user/project) → confirm plan summary → write. EOF or explicit cancel aborts with no writes.
4. **Non-TTY without `--target`**: hard error explaining the flags required (CI safety). Explicit
   flags always bypass interaction entirely.
5. Undetected hosts remain selectable (marked "not detected") — detection is advisory, not a gate.

## Tasks

- [x] T1 (test-first): `lib/detect.mjs` — `detectHosts({ home, pathEnv, platform })` returning
      per-host `{ id, detected, evidence }`; PATH scan + config-dir probes; RED then GREEN.
      Tests: `tests/detect.test.mjs`.
  - Evidence: RED `ERR_MODULE_NOT_FOUND` (0 pass/1 fail) → GREEN 11/11 (`node --test tests/detect.test.mjs`); full `node --test`: 61 tests, 52 pass, 2 pre-existing detect-release fails, 7 pre-existing skips. Commit `036219a` (lib/detect.mjs + tests/detect.test.mjs).
  - Host probes: pi `~/.pi`+`pi`; claude-code `~/.claude`+`claude`; codex `~/.codex`+`codex` (agent-hosts.md documents no Codex config dir — conventional probe kept); opencode `~/.config/opencode`/`~/.opencode`+`opencode`; gemini `~/.gemini`+`gemini`. Exports `HOST_EXECUTABLES` + `HOST_CONFIG_DIRS`.
- [x] T2 (test-first): interactive prompt module with injected `{ input, output }` streams —
      list presentation, multi-select, scope select, confirmation, cancellation semantics.
  - Evidence: RED `ERR_MODULE_NOT_FOUND` → GREEN 8/8; combined detect+prompt 19/19; full `node --test`: 69 tests, 60 pass, 2 pre-existing fails, 7 pre-existing skips. Commit `51e45a3`.
  - API: `selectInstallPlan({ hosts, input, output, describeDestinations? })` → `Promise<{ targets, scope } | null>`; pi rendered detect-only with exact `pi install npm:mobile-agent-orchestrator`; `a`/`all` alias; scope accepts 1/2 or user/project; confirm only exact y/yes; EOF/non-confirm → null (caller writes nothing).
- [x] T3: wire `bin/mobile-agent-orchestrator.mjs`: no-args install → interactive when TTY;
      non-TTY no-args → error; flags bypass; Pi suggestion line; usage update.
      Tests: `tests/cli.test.mjs` (interactive cases with injected streams).
  - Evidence: RED `SyntaxError: does not provide an export named 'run'` → GREEN 8/8 (`tests/cli.test.mjs`); full `node --test`: 77 tests, 68 pass, 2 pre-existing fails, 7 pre-existing skips. Commit `b659582` (bin/ +185/−32, tests/cli.test.mjs new).
  - API: exported async `run(argv, { input, output, errorOutput, isTTY, home, cwd, detect })`; direct execution unchanged. Cancellation → exit 0, zero writes; non-TTY → exit 1 without prompting; explicit `--target` path byte-identical; explicit `--scope` without `--target` validated first and preselects the scope question via a stream proxy in bin (prompt.mjs left untouched).
  - Note: the issue's verification snippet `install --help` (bare `--help` shows usage; `install --help` was never a valid form) and `install --target codex --dry-run` (missing `--scope`, exits 1 by design) are stale in the issue text; corrected forms verified: bare `--help` exit 0 with updated usage, `install --target codex --scope project --dry-run` exit 0. Candidate note for the PR description.
- [x] T4: README installer section documents the no-args interactive flow; usage text updated.
  - Evidence: README.md installer section now leads with the no-args interactive form (detection, evidence display, dedup, Pi detect-only with `pi install npm:mobile-agent-orchestrator`, cancellation = no writes) and keeps the explicit-flag form for CI. Usage text in bin updated in T3. Committed as `2637915` (with this task doc) after explicit user approval of the 4-commit split.
- [ ] T5: full verification: `npm test`, `install --help`, `install --target codex --dry-run`,
      zero-write check; work-unit commits per task; PR to egdev6:main.

## Evidence log

(filled per task above)

## Review round 1 (maintainer, PR #28)

- P1 (blocking): stdin handle kept the process alive after the interactive flow (reproduced on Linux PTY: confirm, cancel, --dry-run, preselected --scope). Fix: `dispose()` on the prompt line reader and on bin's scope proxy (removeListener of exactly the attached data/end/error handlers, pending read settles as cancellation, guarded `pause()`/`unref()`), invoked via try/finally on every exit path; 5 open-input regression tests (stream never ended; assert zero residual listeners). Commit `1600d20`.
- P3: PATH candidates via `existsSync()` matched directories; replaced with `isExecutableFile()` (statSync, regular file, POSIX exec bits `mode & 0o111`, win32 regular file); 3 new tests incl. directory-named-`codex` not detected; existing POSIX fixtures now chmod 0o755. Commit `da2136f`.
- Suite at fix time: 85 tests, 75 pass, 2 pre-existing Windows detect-release fails, 8 skips (7 pre-existing + 1 capability-probed exec-bit test that runs on POSIX and skips on Windows hosts). Real-PTY hang fix verified by listener-count regression tests; manual POSIX PTY pass left to the maintainer.

## Verification (from issue)

```bash
npm test
node bin/mobile-agent-orchestrator.mjs install --help
node bin/mobile-agent-orchestrator.mjs install --target codex --dry-run
```

## PR

- PR #28 "feat(installer): interactive no-arguments install experience" opened by the user (gh unauthenticated; manual open). Closes #14. Label type:feature applied via sidebar by user.
