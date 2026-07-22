import { Buffer } from "node:buffer"
import { TextDecoder } from "node:util"

export function truncateUtf8(
  value: string,
  maximumBytes: number,
  suffix: string,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= maximumBytes) return { text: value, truncated: false }

  const prefixBytes = Math.max(0, maximumBytes - Buffer.byteLength(suffix))
  const prefix = new TextDecoder().decode(bytes.subarray(0, prefixBytes), { stream: true })
  return { text: prefix + suffix, truncated: true }
}
