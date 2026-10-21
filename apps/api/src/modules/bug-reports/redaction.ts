import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'

const sensitiveName = /(?:token|password|passwd|secret|api[_-]?key|authorization|credential|cookie)/i

const native = nativePersistenceRedactor(Object.entries(process.env)
  .filter(([name]) => sensitiveName.test(name))
  .flatMap(([, value]) => value ? [value] : []))

function redactCredentials(text: string): string {
  return native.text(text)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, '[REDACTED]')
    .replace(/(--(?:token|password|passwd|secret|api[_-]?key|authorization|credential|cookie)\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\]]+)/gi, '$1[REDACTED]')
    .replace(/((?:["']?)(?:[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|authorization|credential|cookie)[A-Za-z0-9_-]*)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\]]+)/gi, '$1[REDACTED]')
}

export function redactBugReportText(text: string): string {
  const decoded = text.replace(/"(?:\\.|[^"\\])*"/g, quoted => {
    let value: unknown
    try {
      value = JSON.parse(quoted)
    } catch (error) {
      if (error instanceof SyntaxError) return quoted
      throw error
    }
    if (typeof value !== 'string') return quoted
    const safe = redactCredentials(value)
    return JSON.stringify(safe)
  })
  return redactCredentials(decoded)
}
