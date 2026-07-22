# Releasing

Releases are built from version tags by `.github/workflows/release.yml`. The workflow validates the tag, tests the source, creates and inspects the exact tarball, generates a production SBOM from an isolated tarball installation, publishes to npm, tests the registry artifact in OpenCode, and then creates the GitHub prerelease.

## Current Setup

- The protected `npm` GitHub environment requires approval and accepts only `v*` tags.
- npm Trusted Publishing authorizes `NomaDigitalAds/opencode-ast-tools`, `release.yml`, and the `npm` environment.
- No long-lived npm publication token is stored in GitHub.
- Release tags cannot be updated or deleted.
- `0.1.0-alpha.1` is published with provenance under `alpha`. npm also assigned `latest` to this only published version, so consumers must pin an exact alpha version.

## Release Process

1. Update the version in `package.json`, `package-lock.json`, and the pinned README examples.
2. Merge the release candidate and confirm the `main` CI run is green.
3. Create and push the matching version tag.
4. Inspect the `release-artifacts` workflow artifact before approving the `publish` job.
5. Confirm the registry smoke test, provenance attestation, dist-tag, and GitHub prerelease.

Do not create the GitHub Release manually. The workflow creates it only after the published package passes the OpenCode smoke test. npm CLI `11.16.0` uses the workflow's OIDC identity and generates provenance automatically; the explicit `--provenance` flag remains as a release invariant.

## Verification

Before tagging, run:

```sh
npm ci
npm run check
npm run check:test
npm test
npm run build
npm run test:opencode
npm run check:package
npm publish --dry-run --tag alpha --access public
```
