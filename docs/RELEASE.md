# Release Guide

GitHub tags and npm publication are this project's distribution channels. A stable release is tagged first, then published to npm with provenance from the same workflow run.

## npm trusted publishing prerequisites (maintainer-side)

Before the publish job can succeed, npmjs.com must be configured once:

1. Confirm the `mobile-agent-orchestrator` package name is available and under the maintainer's npm account.
2. Configure the package's **trusted publisher** on npmjs.com: GitHub owner/repository `egdev6/mobile-agent-orchestrator`, workflow filename `tag-release.yml`.
3. Create a granular automation token (`NPM_TOKEN`) scoped to the package and add it as a repository secret: Node 22 ships npm 10.x, which still requires registry credentials even with trusted publishing (upgrading the job to Node 24 / npm >= 11.5.1 enables the fully tokenless path).
4. Confirm the package name and trusted-publisher configuration before merging the publication pull request.

## Release path

1. Open a dedicated release PR. Ordinary merges to `main` never create a tag.
2. Update `package.json` and `skills/mobile-agent-orchestrator/SKILL.md` to the same stable version.
3. Add a matching stable-version heading and release notes to `CHANGELOG.md`.
4. Remove the README draft marker and replace the `vX.Y.Z` future-install placeholder with the published stable tag. The validator also rejects legacy `<owner>` and `<tag>` placeholders.
5. Run `npm test`, review the release PR, and merge it into `main`.

After the merge, the workflow uses GitHub's pull-request association API to prove that `GITHUB_SHA` belongs to a merged pull request targeting `main`. It then validates the merged revision, confirms that `package.json` has a real stable-version change from the pushed base, and creates one annotated tag object and its immutable `vX.Y.Z` ref through the GitHub API. In the same workflow run, the `publish` job then publishes the package to npm with provenance — it never waits for a second, tag-triggered workflow.

## npm publication semantics

The `publish` job runs only when the tag job succeeded, and it re-verifies defense-in-depth before publishing:

1. The annotated `vX.Y.Z` tag must exist and peel to the merged commit (same validation as the tag job).
2. The local tarball integrity (`sha512-…` from `npm pack --dry-run --json`, which empirically matches a real pack on npm 10.x and 11.x) is computed and compared against the registry.
3. `npm view mobile-agent-orchestrator@$VERSION dist.integrity` decides:
   - version not on the registry (`E404`) → publish with `npm publish --provenance`;
   - already published with the SAME integrity → successful no-op (a rerun never overwrites);
   - already published with a DIFFERENT integrity → fail closed, naming both integrities (npm packages are immutable; a content change must be a new version);
   - any other registry error → fail closed rather than publish on an unknown state.

The job's permissions are least-privilege: `contents: read` and `id-token: write` (the OIDC claim that binds the provenance attestation to this repository, workflow, and ref). Publication failure does not invalidate the tag; fixing the cause and re-running the workflow publishes the same validated revision.

The publish job pins its full Node version (`22.14.0`, not a floating `22`) because the rerun guard compares the local tarball integrity against the registry's, and tarball bytes can change between npm minors (npm/cli#7610): a floating `node-version` could change the bundled npm between the original publish and a rerun, turning a safe no-op into a false fail-closed. Keep this pin stable for the life of any published version.

## Guardrails

- Prerelease versions such as `0.1.0-dev.0` are never tagged.
- A rerun is a successful no-op only when the existing ref targets an annotated tag object whose peeled commit is the merged SHA; lightweight or conflicting tags fail rather than being replaced.
- The workflow creates annotated tag objects and refs through the GitHub API; it does not use `git push` to create tags.
- The workflow does not itself prevent direct pushes to `main`; branch protection is configured externally. Direct pushes cannot create a release tag because the workflow fails closed without proven merged-pull-request provenance.
- Do not create a tag manually for this workflow; tags are immutable release records.
- npm packages are immutable too: the publish job never overwrites a published version, and an existing version with different local content fails closed instead of publishing.
- The publish job holds only `contents: read` and `id-token: write`; no other permission is escalated for publication.

## Verification

Use `npm test` to validate metadata, skill packaging, local Markdown links, the npm dry-run file list, and stable-release requirements. This foundation does not claim a published tag or completed operational validation.
