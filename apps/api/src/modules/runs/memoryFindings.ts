import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { clipUtf8 } from '../memory-boards/digest.js'

/** Findings are JSON values; empty values still represent unresolved work. */
export function memoryFindingReason(findings: readonly unknown[]): string {
  const lines = findings.map(finding => {
    if (typeof finding === 'string') return finding.trim()
    if (finding === null || Array.isArray(finding) && !finding.length) return ''
    return canonicalJson(finding)
  }).filter(Boolean)
  return clipUtf8(lines.join('\n') || 'The result contains unresolved findings that need direction.', 1000)
}
