import { AstToolError } from "../errors.js"

type EnginePosition = { line: number; column: number }
type EngineRange = {
  byteOffset: { start: number; end: number }
  start: EnginePosition
  end: EnginePosition
}
type EngineCapture = { text: string; range: EngineRange }

export type EngineMatch = {
  text: string
  range: EngineRange
  file: string
  lines: string
  charCount: { leading: number; trailing: number }
  replacement?: string
  replacementOffsets?: { start: number; end: number }
  language: string
  metaVariables?: {
    single: Record<string, EngineCapture>
    multi: Record<string, EngineCapture[]>
    transformed: Record<string, string>
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", `${label} must be a string`)
  }
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", `${label} must be a non-negative integer`)
  }
  return value as number
}

function range(value: unknown, label: string): EngineRange {
  const input = record(value, label)
  const byteOffset = record(input.byteOffset, `${label}.byteOffset`)
  const start = record(input.start, `${label}.start`)
  const end = record(input.end, `${label}.end`)
  const parsed = {
    byteOffset: {
      start: integer(byteOffset.start, `${label}.byteOffset.start`),
      end: integer(byteOffset.end, `${label}.byteOffset.end`),
    },
    start: {
      line: integer(start.line, `${label}.start.line`),
      column: integer(start.column, `${label}.start.column`),
    },
    end: {
      line: integer(end.line, `${label}.end.line`),
      column: integer(end.column, `${label}.end.column`),
    },
  }
  if (parsed.byteOffset.end < parsed.byteOffset.start) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", `${label} has a reversed byte range`)
  }
  return parsed
}

function capture(value: unknown, label: string): EngineCapture {
  const input = record(value, label)
  return { text: string(input.text, `${label}.text`), range: range(input.range, `${label}.range`) }
}

function captures(value: unknown, label: string): EngineMatch["metaVariables"] {
  const input = record(value, label)
  const singleInput = record(input.single, `${label}.single`)
  const multiInput = record(input.multi, `${label}.multi`)
  const transformedInput = record(input.transformed, `${label}.transformed`)
  const single: Record<string, EngineCapture> = {}
  const multi: Record<string, EngineCapture[]> = {}
  const transformed: Record<string, string> = {}

  for (const [name, item] of Object.entries(singleInput)) single[name] = capture(item, `${label}.single.${name}`)
  for (const [name, items] of Object.entries(multiInput)) {
    if (!Array.isArray(items)) {
      throw new AstToolError("ENGINE_OUTPUT_INVALID", `${label}.multi.${name} must be an array`)
    }
    multi[name] = items.map((item, index) => capture(item, `${label}.multi.${name}[${index}]`))
  }
  for (const [name, item] of Object.entries(transformedInput)) {
    transformed[name] = string(item, `${label}.transformed.${name}`)
  }
  return { single, multi, transformed }
}

function match(value: unknown, index: number): EngineMatch {
  const label = `result[${index}]`
  const input = record(value, label)
  const charCount = record(input.charCount, `${label}.charCount`)
  const parsed: EngineMatch = {
    text: string(input.text, `${label}.text`),
    range: range(input.range, `${label}.range`),
    file: string(input.file, `${label}.file`),
    lines: string(input.lines, `${label}.lines`),
    charCount: {
      leading: integer(charCount.leading, `${label}.charCount.leading`),
      trailing: integer(charCount.trailing, `${label}.charCount.trailing`),
    },
    language: string(input.language, `${label}.language`),
  }
  if (input.replacement !== undefined) parsed.replacement = string(input.replacement, `${label}.replacement`)
  if (input.replacementOffsets !== undefined) {
    const offsets = record(input.replacementOffsets, `${label}.replacementOffsets`)
    parsed.replacementOffsets = {
      start: integer(offsets.start, `${label}.replacementOffsets.start`),
      end: integer(offsets.end, `${label}.replacementOffsets.end`),
    }
  }
  if (input.metaVariables !== undefined) {
    const metaVariables = captures(input.metaVariables, `${label}.metaVariables`)
    if (metaVariables) parsed.metaVariables = metaVariables
  }
  return parsed
}

export function parseEngineJson(output: string): EngineMatch[] {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch (error) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", "ast-grep returned invalid JSON", { cause: error })
  }
  if (!Array.isArray(value)) {
    throw new AstToolError("ENGINE_OUTPUT_INVALID", "ast-grep output must be a JSON array")
  }
  return value.map(match)
}

export function flattenCaptures(meta: EngineMatch["metaVariables"]): Record<string, string> | undefined {
  if (!meta) return undefined
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(meta.single)) output[name] = value.text
  for (const [name, values] of Object.entries(meta.multi)) output[name] = values.map((value) => value.text).join("")
  Object.assign(output, meta.transformed)
  return Object.keys(output).length === 0 ? undefined : output
}
