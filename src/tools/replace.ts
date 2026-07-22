import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { Buffer } from "node:buffer"
import { DEFAULTS, HARD_LIMITS, LANGUAGES, PLUGIN_VERSION } from "../constants.js"
import { applyEdits, prepareEdits } from "../edits.js"
import { runEngine, type Engine } from "../engine/cli.js"
import { AstToolError } from "../errors.js"
import { discoverFiles, matchesGlobs } from "../filesystem/discovery.js"
import { loadFile, resolveWorktree, validateScopePaths } from "../filesystem/scope.js"
import { sha256 } from "../hash.js"
import { createUnifiedDiff } from "../output/diff.js"
import { renderPreview, type PreviewFile } from "../output/render.js"
import { PlanStore } from "../plans/store.js"
import type { AstEdit, PlannedFile, PluginConfig } from "../types.js"
import {
  validateByteLength,
  validateGlobs,
  validateInteger,
  validateLanguage,
  validatePaths,
} from "../validation.js"
import { askRead } from "./shared.js"

export function createReplaceTool(engine: Engine, config: PluginConfig, store: PlanStore): ToolDefinition {
  return tool({
    description: "Preview only. Does not modify files. Returns a plan for ast_grep_apply.",
    args: {
      operations: tool.schema
        .array(
          tool.schema.object({
            pattern: tool.schema.string(),
            replacement: tool.schema.string(),
          }),
        )
        .min(1)
        .max(HARD_LIMITS.operations),
      language: tool.schema.enum(LANGUAGES),
      paths: tool.schema.array(tool.schema.string()).max(HARD_LIMITS.paths).optional(),
      include: tool.schema.array(tool.schema.string()).max(HARD_LIMITS.globs).optional(),
      exclude: tool.schema.array(tool.schema.string()).max(HARD_LIMITS.globs).optional(),
      maxFiles: tool.schema.number().int().min(1).max(HARD_LIMITS.changedFiles).optional(),
      maxReplacements: tool.schema.number().int().min(1).max(HARD_LIMITS.replacements).optional(),
    },
    async execute(args, context) {
      validateLanguage(args.language)
      const patterns = new Set<string>()
      for (const [index, operation] of args.operations.entries()) {
        validateByteLength(operation.pattern, `operations[${index}].pattern`)
        validateByteLength(
          operation.replacement,
          `operations[${index}].replacement`,
          true,
          HARD_LIMITS.replacementBytes,
        )
        if (patterns.has(operation.pattern)) {
          throw new AstToolError("INVALID_ARGUMENT", `duplicate pattern at operations[${index}]`)
        }
        patterns.add(operation.pattern)
      }
      const requestedPaths = validatePaths(args.paths)
      const include = validateGlobs(args.include, "include")
      const exclude = validateGlobs(args.exclude, "exclude")
      const maxFiles = args.maxFiles ?? config.limits.maxChangedFiles
      const maxReplacements = args.maxReplacements ?? config.limits.maxReplacements
      validateInteger(maxFiles, "maxFiles", 1, HARD_LIMITS.changedFiles)
      validateInteger(maxReplacements, "maxReplacements", 1, HARD_LIMITS.replacements)

      const realWorktree = await resolveWorktree(context.worktree)
      const paths = await validateScopePaths(realWorktree, requestedPaths)
      await askRead(context, paths, "ast_grep_replace")
      const deadline = Date.now() + DEFAULTS.replaceTimeoutMs
      const discovery = await discoverFiles({
        realWorktree,
        scopes: paths,
        language: args.language,
        include,
        exclude,
        respectGitignore: config.respectGitignore,
        allowIgnoredFiles: config.allowIgnoredFiles,
        signal: context.abort,
        deadline,
      })
      if (discovery.truncated) {
        throw new AstToolError(
          "LIMIT_EXCEEDED",
          `rewrite scope exceeds the ${discovery.limit}-file discovery limit; no plan was created`,
        )
      }
      const editsByPath = new Map<string, AstEdit[]>()
      const warnings: string[] = []
      let engineOutputBytes = 0
      let replacementCount = 0

      for (const [operationIndex, operation] of args.operations.entries()) {
        const remainingTime = deadline - Date.now()
        if (remainingTime <= 0) {
          throw new AstToolError("ENGINE_TIMEOUT", `preview exceeded ${DEFAULTS.replaceTimeoutMs}ms`)
        }
        const result = await runEngine(engine, {
          pattern: operation.pattern,
          replacement: operation.replacement,
          language: args.language,
          paths: discovery.paths,
          include,
          exclude,
          contextLines: 0,
          respectGitignore: config.respectGitignore,
          allowIgnoredFiles: config.allowIgnoredFiles,
          timeoutMs: remainingTime,
          signal: context.abort,
          cwd: realWorktree,
          outputLimitBytes: HARD_LIMITS.engineOutputBytes - engineOutputBytes,
          preselectedPaths: true,
        })
        engineOutputBytes += result.outputBytes
        if (engineOutputBytes > HARD_LIMITS.engineOutputBytes) {
          throw new AstToolError("LIMIT_EXCEEDED", "combined ast-grep stdout exceeded 8 MiB")
        }
        warnings.push(...result.warnings)
        for (const item of result.matches) {
          const relativePath = item.file.replaceAll("\\", "/")
          if (!matchesGlobs(relativePath, include, exclude)) continue
          if (item.replacement === undefined || item.replacementOffsets === undefined) {
            throw new AstToolError("ENGINE_OUTPUT_INVALID", "rewrite output omitted replacement data")
          }
          const edits = editsByPath.get(relativePath) ?? []
          edits.push({
            byteStart: item.replacementOffsets.start,
            byteEnd: item.replacementOffsets.end,
            replacement: Buffer.from(item.replacement, "utf8"),
            matchStart: item.range.byteOffset.start,
            matchEnd: item.range.byteOffset.end,
            matchText: item.text,
            operationIndex,
          })
          editsByPath.set(relativePath, edits)
          replacementCount += 1
          if (replacementCount > maxReplacements) {
            throw new AstToolError("LIMIT_EXCEEDED", `rewrite exceeds maxReplacements (${maxReplacements})`)
          }
          if (editsByPath.size > HARD_LIMITS.changedFiles) {
            throw new AstToolError("LIMIT_EXCEEDED", `rewrite exceeds ${HARD_LIMITS.changedFiles} changed files`)
          }
        }
      }

      const files: PlannedFile[] = []
      let plannedBytes = 0
      for (const [relativePath, rawEdits] of editsByPath) {
        if (context.abort.aborted) throw new AstToolError("ABORTED", "operation was aborted")
        if (Date.now() > deadline) {
          throw new AstToolError("ENGINE_TIMEOUT", `preview exceeded ${DEFAULTS.replaceTimeoutMs}ms`)
        }
        const snapshot = await loadFile(realWorktree, relativePath)
        if (context.abort.aborted) throw new AstToolError("ABORTED", "operation was aborted")
        if (Date.now() > deadline) throw new AstToolError("ENGINE_TIMEOUT", "preview timed out while loading files")
        const edits = prepareEdits(snapshot.bytes, rawEdits)
        if (edits.length === 0) continue
        if (files.length >= maxFiles) {
          throw new AstToolError("LIMIT_EXCEEDED", `rewrite changes more than ${maxFiles} files`)
        }
        const after = applyEdits(snapshot.bytes, edits)
        if (after.length > HARD_LIMITS.fileBytes) {
          throw new AstToolError("LIMIT_EXCEEDED", `rewritten file exceeds ${HARD_LIMITS.fileBytes} bytes: ${relativePath}`)
        }
        plannedBytes += snapshot.bytes.length + after.length
        if (plannedBytes > HARD_LIMITS.planStoreBytes) {
          throw new AstToolError("LIMIT_EXCEEDED", "plan exceeds the 64 MiB in-memory store limit")
        }
        files.push({
          relativePath: snapshot.relativePath,
          realPath: snapshot.realPath,
          before: snapshot.bytes,
          after,
          beforeSha256: sha256(snapshot.bytes),
          afterSha256: sha256(after),
          mode: snapshot.mode,
          replacements: edits.length,
        })
      }
      files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      if (files.length === 0) {
        return {
          title: "ast-grep preview: no changes",
          output: "Preview only. Does not modify files. The rewrite produced no byte changes, so no plan was created.",
          metadata: {
            engine: { name: "ast-grep", version: engine.version },
            discovery: { files: discovery.files, limit: discovery.limit, truncated: discovery.truncated },
            totals: { files: 0, replacements: 0, diffBytes: 0 },
            warnings: warnings.slice(0, 20),
          },
        }
      }

      const maximumDiffBytes = Math.max(4_096, Math.floor((HARD_LIMITS.modelOutputBytes - 4_096) / files.length))
      const previews: PreviewFile[] = []
      for (const file of files) {
        if (context.abort.aborted) throw new AstToolError("ABORTED", "operation was aborted")
        if (Date.now() > deadline) {
          throw new AstToolError("ENGINE_TIMEOUT", `preview exceeded ${DEFAULTS.replaceTimeoutMs}ms`)
        }
        const diff = createUnifiedDiff(file.relativePath, file.before, file.after, maximumDiffBytes)
        if (Date.now() > deadline) throw new AstToolError("ENGINE_TIMEOUT", "preview timed out while rendering diffs")
        previews.push({
          path: file.relativePath,
          replacements: file.replacements,
          beforeSha256: file.beforeSha256,
          afterSha256: file.afterSha256,
          diff: diff.text,
          diffTruncated: diff.truncated,
        })
      }
      const diffBytes = previews.reduce((total, file) => total + Buffer.byteLength(file.diff), 0)
      const plan = store.create(
        {
          sessionId: context.sessionID,
          realWorktree,
          pluginVersion: PLUGIN_VERSION,
          engineVersion: engine.version,
        },
        files,
      )
      return {
        title: `ast-grep preview: ${files.length} file(s)`,
        output: renderPreview(plan, previews),
        metadata: {
          planId: plan.id,
          expiresAt: new Date(plan.expiresAt).toISOString(),
          engine: { name: "ast-grep", version: engine.version },
          discovery: { files: discovery.files, limit: discovery.limit, truncated: discovery.truncated },
          totals: {
            files: files.length,
            replacements: files.reduce((total, file) => total + file.replacements, 0),
            diffBytes,
          },
          files: previews,
          warnings: warnings.slice(0, 20),
        },
      }
    },
  })
}
