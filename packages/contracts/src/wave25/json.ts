import { canonicalGraphJson } from '../canonicalJson.js'

export { canonicalGraphJson }

export function graphJsonBytes(value: unknown): number {
  try { return new TextEncoder().encode(canonicalGraphJson(value)).byteLength } catch { return Infinity }
}
