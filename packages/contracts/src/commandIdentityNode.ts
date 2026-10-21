import { createHash } from 'node:crypto'
import { canonicalJsonLocaleOrderLegacy } from './canonicalJson.js'

export function commandInputHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonLocaleOrderLegacy(value)).digest('hex')}`
}
