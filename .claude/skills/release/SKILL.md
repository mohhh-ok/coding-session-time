---
name: npm-release
description: Cut a release of an npm package — run tests, bump the version, build, publish to npm, and push the tag. Use when the user says "release", "publish to npm", "cut a release", "ship vX.Y.Z", or asks to bump the version and publish. Picks patch/minor/major based on the user's instruction; asks if unspecified. NOT for installing packages or running tests on their own — only for the full publish workflow.
---

# npm-release

Release workflow for an npm package: verify the tree, run tests, bump the version, build, publish, and push the tag. Designed to be safe and stop the moment anything looks off.

## When to use

Trigger on any of: "release", "publish", "cut a release", "ship", "bump version and publish". Do NOT trigger on plain "bump version" without publish, or "run tests" — those are narrower asks.

## Preflight (do every time, in order)

Stop and ask the user before continuing if any check fails. Never bypass.

1. **Working tree is clean.** `git status --porcelain` must be empty. If not, ask the user to commit or stash first.
2. **On the release branch.** `git rev-parse --abbrev-ref HEAD` should match the project's release branch (usually `main` or `master`). If not, confirm with the user before proceeding.
3. **Up to date with remote.** `git fetch` then compare `HEAD` to `origin/<branch>`. If behind, pull first; if diverged, ask.
4. **Tests pass.** Use the package's own test script: prefer `npm test` if `package.json` has a `test` script that isn't the placeholder `"echo \"Error: no test specified\""`. For Bun-based projects, `bun test` is also fine. If tests fail, stop — do not bump or publish.
5. **Build succeeds.** If `package.json` has a `build` script, run it now to catch issues before creating a commit/tag. (Note: `npm publish` will run `prepublishOnly` again — this is just an early check.)

## Version bump

1. Read the current version from `package.json`.
2. Determine the bump type:
   - If the user specified `patch` / `minor` / `major` or an explicit version (`1.2.3`), use that.
   - Otherwise, ask: "patch / minor / major?" with the resulting version numbers shown for each option (e.g. "patch → 0.1.1, minor → 0.2.0, major → 1.0.0"). Default to patch unless the changes clearly warrant otherwise.
3. Run `npm version <bump>` (or `npm version <explicit>`). This creates a commit and a tag automatically. Do not pass `--no-git-tag-version` — we want the tag.

## Publish

1. **Authenticate.** `npm whoami` — if it errors, tell the user to run `npm login` and stop.
2. **Dry run first.** `npm publish --dry-run` and show the user the file list. Confirm it looks right (no source maps in dist-only packages, no `.env`, no node_modules).
3. **Publish.** `npm publish`. If the package is scoped and meant to be public, include `--access public`.
4. **Push the tag.** `git push --follow-tags` to push both the version commit and the tag to the remote.

## Rollback / failure handling

- If `npm publish` fails after the version commit/tag was created, do NOT delete the tag silently. Tell the user the tag exists locally, and ask whether to retry publish, deprecate the version, or roll back (`git tag -d v<x>` + `git reset --hard HEAD~1`).
- If publish succeeded but the push failed, the npm registry now has a version that isn't in git. Push immediately or alert the user.
- Never `npm unpublish` automatically — that's destructive and rate-limited by npm. Surface the situation to the user.

## What to report

After a successful release, give the user:
- The new version (e.g. `0.2.0`)
- The npm URL: `https://www.npmjs.com/package/<name>`
- The git tag (e.g. `v0.2.0`) and that it was pushed

Keep it under 4 lines. No celebration emoji unless the user uses them first.

## Notes

- `prepublishOnly` in `package.json` is the right place for tests + build to run automatically during `npm publish`. If the project already has it, the manual test/build step in this skill is a defense-in-depth check, not redundancy — it catches problems before the version commit is created.
- For monorepos, this skill targets a single package directory. If invoked at a workspace root, ask the user which package to release.
- Two-factor auth: if `npm publish` prompts for an OTP, pass it through with `--otp=<code>` once the user provides it.
