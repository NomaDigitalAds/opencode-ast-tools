# OpenCode AST Tools

Safe structural search and AST refactoring for OpenCode, powered by the official `ast-grep` CLI.

The plugin deliberately separates preview from writing:

- `ast_grep_search` searches syntax trees and never writes files.
- `ast_grep_replace` calculates an immutable preview and stores a short-lived in-memory plan. It never writes files.
- `ast_grep_apply` applies exactly one previously generated plan after checking edit permission, path containment, ownership, expiry, engine version, and file hashes.

## Install

Pin the plugin version in `opencode.json`:

```json
{
  "plugin": ["opencode-ast-tools@0.1.0"]
}
```

Optional limits can be provided with the plugin entry:

```json
{
  "plugin": [
    [
      "opencode-ast-tools@0.1.0",
      {
        "limits": {
          "maxSearchResults": 50,
          "maxChangedFiles": 50,
          "maxReplacements": 500,
          "planTtlSeconds": 900
        },
        "respectGitignore": true,
        "allowIgnoredFiles": false
      }
    ]
  ]
}
```

Tool catalog permission and filesystem permission are separate. `ast_grep_search` and `ast_grep_replace` request `read` access to their input scopes. `ast_grep_apply` requests `edit` access to the exact files in its plan, so an agent configured with `edit: deny` cannot apply a preview.

## Search

```json
{
  "pattern": "console.log($ARG)",
  "language": "typescript",
  "paths": ["src"],
  "include": ["**/*.ts"],
  "contextLines": 1,
  "maxResults": 50
}
```

`$NAME` captures one named AST node, `$_` is anonymous, `$$$NAME` captures zero or more nodes, and `$$$` is an unnamed multi-node wildcard. Ranges shown to the model use one-based lines and columns; byte offsets remain zero-based and end-exclusive.

## Preview And Apply

Create a preview:

```json
{
  "operations": [
    {
      "pattern": "console.log($ARG)",
      "replacement": "logger.info($ARG)"
    }
  ],
  "language": "typescript",
  "paths": ["src"],
  "include": ["**/*.ts"]
}
```

If the rewrite changes bytes, the result contains a `planId`, hashes, and bounded unified diffs. Apply only that identifier:

```json
{
  "planId": "0123456789abcdef0123456789abcdef"
}
```

Apply does not accept paths, patterns, replacements, caller-provided edits, `force`, or output text. Plans are bound to the OpenCode session and real worktree, expire after 15 minutes by default, live only in memory, and are consumed after a successful apply.

## Supported Languages

`bash`, `c`, `cpp`, `csharp`, `css`, `elixir`, `go`, `haskell`, `html`, `java`, `javascript`, `json`, `kotlin`, `lua`, `nix`, `php`, `python`, `ruby`, `rust`, `scala`, `solidity`, `swift`, `typescript`, `tsx`, and `yaml`.

## Safety Model

- Only relative paths contained by the real worktree are accepted. Absolute paths, `..` traversal, symlink escapes, junction escapes, and non-regular result files are rejected.
- The installed `@ast-grep/cli` executable is resolved directly and checked for version `0.44.1`. The plugin does not search `PATH`, invoke a shell, load project grammars, or download executables at runtime.
- Files must be UTF-8 and no larger than 5 MiB. Rewrites operate on byte ranges, preserving BOM, line endings, and all bytes outside each range.
- Discovery is deterministic and limited to 10,000 language-eligible files. Search reports a truncated scope; replace fails without creating a partial plan.
- Identical edits are deduplicated and overlapping edits fail before staging.
- Apply rechecks every source hash before staging and immediately before commit. A stale plan writes no files.
- Outputs are bounded, terminal control characters are removed from model-facing text, and invalid engine JSON is an error rather than an empty result.

Each file is replaced with a same-directory rename when the filesystem supports atomic rename. A multi-file apply is not a crash-recoverable transaction: a failure during the rename sequence can produce a partial commit. The plugin keeps original bytes through commit, attempts best-effort rollback, and reports `COMMIT_PARTIAL` if at least one file was replaced or `COMMIT_FAILED` if none were.

These checks detect known path, content, and mode changes immediately before each rename. Portable Node.js does not provide directory-relative `renameat` operations, so the final pathname check and rename cannot be one atomic operation. The apply guarantees assume no hostile process with permission to rename entries in target directories during that final interval.

## Development

```sh
npm install
npm run check
npm test
npm run build
```

Set `AST_GREP_INTEGRATION=1` when running `npm test` to execute search and rewrite fixtures for every advertised language. CI runs those fixtures on Windows x64, Linux x64 GNU, macOS arm64, and macOS x64. The native `ast-grep` executable must be allowed by the host's application-control policy for these end-to-end tests.

## License

The plugin is MIT licensed. Direct dependency notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Development milestones and remaining MVP evidence are tracked in [`ROADMAP.md`](ROADMAP.md).
