import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { DEFAULTS, HARD_LIMITS, LANGUAGES } from "../constants.js"
import { runEngine, type Engine } from "../engine/cli.js"
import { flattenCaptures } from "../engine/json.js"
import { AstToolError } from "../errors.js"
import { loadFile, resolveWorktree, validateScopePaths } from "../filesystem/scope.js"
import { renderSearch } from "../output/render.js"
import type { AstSearchMatch, AstSearchResult, PluginConfig } from "../types.js"
import {
  validateByteLength,
  validateGlobs,
  validateInteger,
  validateLanguage,
  validatePaths,
  validateRelativePath,
} from "../validation.js"
import { askRead, matchesGlobs } from "./shared.js"

export function createSearchTool(engine: Engine, config: PluginConfig): ToolDefinition {
  return tool({
    description: "Search code structurally with ast-grep. Read-only; never modifies files.",
    args: {
      pattern: tool.schema.string(),
      language: tool.schema.enum(LANGUAGES),
      paths: tool.schema.array(tool.schema.string()).max(HARD_LIMITS.paths).optional(),
      include: tool.schema.array(tool.schema.string()).max(HARD_LIMITS.globs).optional(),
      exclude: tool.schema.array(tool.schema.string()).max(HARD_LIMITS.globs).optional(),
      contextLines: tool.schema.number().int().min(0).max(8).optional(),
      maxResults: tool.schema.number().int().min(1).max(HARD_LIMITS.searchResults).optional(),
    },
    async execute(args, context) {
      validateByteLength(args.pattern, "pattern")
      validateLanguage(args.language)
      const requestedPaths = validatePaths(args.paths)
      const include = validateGlobs(args.include, "include")
      const exclude = validateGlobs(args.exclude, "exclude")
      const contextLines = args.contextLines ?? DEFAULTS.contextLines
      const maxResults = args.maxResults ?? config.limits.maxSearchResults
      validateInteger(contextLines, "contextLines", 0, 8)
      validateInteger(maxResults, "maxResults", 1, HARD_LIMITS.searchResults)

      const realWorktree = await resolveWorktree(context.worktree)
      const paths = await validateScopePaths(realWorktree, requestedPaths)
      await askRead(context, paths, "ast_grep_search")
      const deadline = Date.now() + DEFAULTS.searchTimeoutMs
      const engineResult = await runEngine(engine, {
        pattern: args.pattern,
        language: args.language,
        paths,
        include,
        exclude,
        contextLines,
        respectGitignore: config.respectGitignore,
        allowIgnoredFiles: config.allowIgnoredFiles,
        timeoutMs: DEFAULTS.searchTimeoutMs,
        signal: context.abort,
        cwd: realWorktree,
      })

      const candidates = engineResult.matches
        .map((item) => ({ item, relativePath: validateRelativePath(item.file.replaceAll("\\", "/")) }))
        .filter(({ relativePath }) => matchesGlobs(relativePath, include, exclude))
        .sort(
          (left, right) =>
            left.relativePath.localeCompare(right.relativePath) ||
            left.item.range.byteOffset.start - right.item.range.byteOffset.start,
        )
      const matches: AstSearchMatch[] = []
      let lastSnapshot: Awaited<ReturnType<typeof loadFile>> | undefined
      let lastRequestedPath = ""
      for (const { item, relativePath } of candidates.slice(0, maxResults)) {
        if (context.abort.aborted) throw new AstToolError("ABORTED", "operation was aborted")
        if (Date.now() > deadline) {
          throw new AstToolError("ENGINE_TIMEOUT", `search exceeded ${DEFAULTS.searchTimeoutMs}ms`)
        }
        const snapshot = lastRequestedPath === relativePath
          ? lastSnapshot
          : await loadFile(realWorktree, relativePath)
        if (!snapshot) throw new AstToolError("PATH_NOT_FOUND", `path not found: ${relativePath}`)
        lastSnapshot = snapshot
        lastRequestedPath = relativePath
        const { start, end } = item.range.byteOffset
        if (end > snapshot.bytes.length || snapshot.bytes.subarray(start, end).toString("utf8") !== item.text) {
          throw new AstToolError("ENGINE_OUTPUT_INVALID", `match does not agree with file bytes: ${relativePath}`)
        }
        const match: AstSearchMatch = {
          path: snapshot.relativePath,
          language: item.language,
          range: {
            byteStart: start,
            byteEnd: end,
            start: { line: item.range.start.line + 1, column: item.range.start.column + 1 },
            end: { line: item.range.end.line + 1, column: item.range.end.column + 1 },
          },
          text: item.text,
          context: item.lines,
        }
        const captures = flattenCaptures(item.metaVariables)
        if (captures) match.captures = captures
        matches.push(match)
      }
      const totalSeen = candidates.length
      const result: AstSearchResult = {
        engine: { name: "ast-grep", version: engine.version },
        worktree: ".",
        matches: matches.slice(0, maxResults),
        totalSeen,
        truncated: totalSeen > maxResults,
        warnings: engineResult.warnings,
      }
      const metadata = {
        ...result,
        matches: result.matches.map(({ context: _context, ...match }) => match),
      }
      return {
        title: `ast-grep search: ${result.matches.length} match(es)`,
        output: renderSearch(result),
        metadata,
      }
    },
  })
}
