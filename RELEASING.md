# Releasing

Releases are built from version tags by `.github/workflows/release.yml`. The workflow validates the tag, tests the source, creates and inspects the exact tarball, generates a production SBOM from an isolated tarball installation, publishes to npm, tests the registry artifact in OpenCode, and then creates the GitHub prerelease.

## First Publish

The package must exist on npm before Trusted Publishing can be configured in its package settings.

1. Create a protected GitHub environment named `npm` and require approval for deployments.
2. Create a granular npm access token that can publish `opencode-ast-tools` with 2FA bypass enabled.
3. Store it as the `NPM_TOKEN` secret in the `npm` GitHub environment.
4. Merge the release candidate and confirm the `main` CI run is green.
5. Create and push the matching tag, for example `v0.1.0-alpha.1`.
6. Inspect the `release-artifacts` workflow artifact before approving the `publish` job.

Do not create the GitHub Release manually. The workflow creates it only after the published package passes the OpenCode smoke test.

## Trusted Publishing

After the first publish, configure the package on npmjs.com with this trusted publisher:

- Provider: GitHub Actions
- Organization: `NomaDigitalAds`
- Repository: `opencode-ast-tools`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Then remove the `NPM_TOKEN` secret. npm CLI `11.16.0` uses the workflow's OIDC identity and generates provenance automatically; the explicit `--provenance` flag remains as a release invariant.

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
