import { describe, expect, it } from "vitest"
import { parseConfig } from "../src/config.js"
import { AstToolError } from "../src/errors.js"
import {
  validateByteLength,
  validateGlobs,
  validateLanguage,
  validateRelativePath,
} from "../src/validation.js"

describe("validation", () => {
  it("accepts supported languages and rejects unknown ones", () => {
    expect(() => validateLanguage("typescript")).not.toThrow()
    expect(() => validateLanguage("plaintext")).toThrowError("UNSUPPORTED_LANGUAGE")
  })

  it("measures pattern limits in UTF-8 bytes", () => {
    expect(() => validateByteLength("a".repeat(8_192), "pattern")).not.toThrow()
    expect(() => validateByteLength("á".repeat(4_097), "pattern")).toThrowError("INVALID_ARGUMENT")
  })

  it.each(["../secret", "src/../secret", "C:\\secret", "\\\\server\\share"]) (
    "rejects escaping path %s",
    (input) => {
      expect(() => validateRelativePath(input)).toThrow(AstToolError)
    },
  )

  it("keeps paths and globs as separate inputs", () => {
    expect(validateRelativePath("src/[id].ts")).toBe("src/[id].ts")
    expect(validateGlobs(["src/**/*.ts"], "include")).toEqual(["src/**/*.ts"])
    expect(() => validateGlobs(["!node_modules/**"], "exclude")).toThrowError("INVALID_ARGUMENT")
  })

  it("applies defaults and enforces configuration hard caps", () => {
    expect(parseConfig(undefined).limits).toEqual({
      maxSearchResults: 50,
      maxChangedFiles: 50,
      maxReplacements: 500,
      planTtlSeconds: 900,
    })
    expect(() => parseConfig({ limits: { maxReplacements: 2_001 } })).toThrowError("INVALID_ARGUMENT")
  })
})
