import { createHash } from 'node:crypto'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'

export function jobDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
