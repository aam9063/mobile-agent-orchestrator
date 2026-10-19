# Issue #17 — npm publication with provenance

Issue: egdev6/mobile-agent-orchestrator#17 "Publish validated stable releases to npm with provenance" (status:approved; blocked by #10, #12-#16 — all merged).
Branch: `feat/issue-17-npm-publication` (NO commits without explicit user approval — commit-approval-policy).
User goal: PR as clean as possible; the maintainer's workflow style (merged-PR provenance, immutable tags, fail-closed guards) is the bar.

## Outcome

Publish validated stable releases to npm with provenance while preserving the existing merged-PR and immutable-tag controls.

## Specs (issue verbatim)

- S1: "The npm package name and trusted publisher configuration are confirmed before merge."
- S2: "`publishConfig` defines the public registry/access policy."
- S3: "The publish job has least-privilege permissions and scopes `id-token: write` only where required."
- S4: "Publication runs `npm publish --provenance` only after the existing release validation and tag job succeed."
- S5: "Publication is integrated into the existing workflow and does not rely on a second workflow being triggered by a tag created with `GITHUB_TOKEN`."
- S6: "A rerun does not attempt to overwrite an existing matching version."
- S7: "An existing version with a different local package integrity fails closed."
- S8: "The tarball contains only the canonical skill and required installer runtime files."
- S9: "README documents both `pi install npm:...` and `npx mobile-agent-orchestrator install`."
- S10: "`CONTRIBUTING.md` and `docs/RELEASE.md` no longer state that npm publication is out of scope."
- S11: "`npm test`, `npm run pack:check`, and `npm publish --dry-run` succeed."
- Non-goals: "Adding installer behavior. Changing the canonical skill workflow. Performing the `v0.2.0` version bump."

## Design decisions

1. **package.json**: add `publishConfig: { registry: "https://registry.npmjs.org/", access: "public" }` (S2). Name stays `mobile-agent-orchestrator`; S1 confirmation (name availability + trusted-publisher setup on npmjs.com for the repo/workflow) is the MAINTAINER's action, noted in the PR body.
2. **Validator (scripts/validate-package.mjs)**: extend package.json checks — publishConfig must be exactly `{ registry: "https://registry.npmjs.org/", access: "public" }`, `private` must be false/absent. Tests in tests/validate-package.test.mjs.
3. **Workflow (.github/workflows/tag-release.yml)**: new `publish` job `needs: [validate, tag]`, `if: needs.validate.outputs.should_tag == 'true'`, permissions `contents: read` + `id-token: write` (job-scoped; S3), integrated in the SAME workflow run (S5). Steps:
   a. checkout at `github.sha`, setup-node (22) with `registry-url: https://registry.npmjs.org/`.
   b. Defense-in-depth tag re-verification: the `v$VERSION` annotated tag must exist and peel to `GITHUB_SHA` (same validation style as the tag job) before publishing.
   c. Rerun guard (S6/S7): query `npm view mobile-agent-orchestrator@$VERSION dist.integrity --json`; 404 → not published → proceed; integrity equal to the local tarball's → exit 0 no-op; integrity different → FAIL CLOSED.
   d. Compute local integrity from a real `npm pack` (temp dir, then discard) — verify empirically whether `npm pack --dry-run --json` exposes `integrity`; if not, pack for real in a temp dir and compute sha512 base64 (`ssha512` format) with node:crypto.
   e. `npm publish --provenance` (S4) only after (b)-(d) pass. `NODE_AUTH_TOKEN` secret (maintainer configures; trusted publishing does not need a long-lived token for the registry, but npm CLI still requires NODE_AUTH_TOKEN or configured credentials — with trusted publishing + OIDC, npm >= 11.5 supports tokenless; verify at implementation time and document what the maintainer must configure).
4. **Docs (S9/S10)**: README — line 22 status note and line 136 distribution paragraph updated to name npm as a publication channel; installation section documents both `pi install npm:...` and `npx mobile-agent-orchestrator install` (npx commands already present). CONTRIBUTING.md line 23 and docs/RELEASE.md "out of scope" statements replaced with the publication flow, trusted-publishing prerequisites, rerun/integrity semantics, and the maintainer-side setup checklist.
5. **Non-goals respected**: no installer changes, no skill workflow changes, NO version bump (stays 0.1.0).
6. **Internal adversarial pass before PR**: workflow YAML review (token permissions, injection via version strings — all quoted/parameterized through env, no `eval`), rerun/integrity race analysis, dry-run proof.

## Tasks

- [x] T1 (test-first): publishConfig validations in scripts/validate-package.mjs + package.json publishConfig + tests/validate-package.test.mjs.
  - Evidence: RED missing-export → GREEN 10/10 focused; full suite 154 tests, 141 pass, 2 pre-existing fails, 11 skips. Uncommitted (package.json +4, validator +76/−29 behavior-preserving extraction into exported `validatePackageJson`, tests +58).
  - Notes: publishConfig is the sole package.json change; `npm publish --dry-run` was blocked by the child safety policy (parent runs it in T4); `node scripts/validate-package.mjs` cannot exit 0 on this Windows host (pre-existing npm ENOENT, base-confirmed). Scratch /tmp/tmp.zYQCa87Rp1 removed by parent.
- [x] T2: publish job in .github/workflows/tag-release.yml (rerun guard, integrity fail-closed, provenance).
  - Evidence: additions-only diff (+172, existing jobs byte-identical); js-yaml parse OK; bash -n 7/7 run blocks; zero ${{ }} inside run blocks (all via env:/with:); workflow-level permissions unchanged; publish job exactly contents: read + id-token: write. Empirical finding: `npm pack --dry-run --json` DOES expose `integrity` (verified npm 10.9.x and 11.16.0) — dry-run used directly with strict shape validation, no temp tarball.
  - Deviation (documented): `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step (node 22 bundles npm 10.x which requires registry credentials); job comment documents the tokenless path (node 24 / npm >= 11.5.1). S1 maintainer checklist includes creating the granular NPM_TOKEN secret + trusted-publisher config on npmjs.com. Scratch /tmp/tmp.1ZW9BcuBLn removed by parent.
- [ ] T3: README + CONTRIBUTING.md + docs/RELEASE.md (S9/S10).
- [x] T4: adversarial workflow pass + full verification (`npm test`, `pack:check`, `npm publish --dry-run`) + commits ON USER APPROVAL + PR.
  - Adversarial pass (jd-judge-a): 3 findings. JD-A-001 CRITICAL (FIXED): GITHUB_ENV case mismatch — writer emitted `local_integrity`, guard read `$LOCAL_INTEGRITY`; under `set -u` the rerun no-op and the fail-closed diagnostic crashed before converging (first-publish path unaffected). Fix: writer emits `LOCAL_INTEGRITY`; programmatic checker asserts all writer/reader pairs agree. JD-A-002 WARNING (FIXED): README claimed v0.1.0 was npm-published — impossible (release detection requires a version change; non-goal forbids the bump) and live probe shows the package absent from npm. Fix: prospective wording, Git tag as the current channel, npm block titled "next stable release onward". JD-A-003 = known pre-existing Windows detect-release failures (out of diff).
  - Verification: js-yaml parse OK; bash -n 4/4 publish-job run blocks; `git diff --check` clean; zero `${{ }}` inside run blocks; npm publish --dry-run exit 0 (13 canonical files); pack:check 0; suite 154/141/2/11. Uncommitted pending user approval.

## Evidence log

(filled per task)
