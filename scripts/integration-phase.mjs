import { basename } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

export function integrationPhaseLine(file, phase, elapsedMs) {
  const label = phase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `[integration-phase] ${basename(file)} ${label} ${Math.round(elapsedMs)}`
}

/** Forward setup summaries while retaining ordinary output in the file log. */
export function integrationPhaseForwarder(write) {
  let pending = ''
  const forward = line => {
    const summary = /\[integration-phase\] [\w.-]+ [a-z0-9-]+ \d+\s*$/.exec(stripVTControlCharacters(line))
    if (summary) write(summary[0].trim())
  }
  return {
    push(chunk) {
      const lines = `${pending}${String(chunk)}`.split('\n')
      pending = lines.pop().slice(-4096)
      for (const line of lines) forward(line)
    },
    finish() {
      forward(pending)
      pending = ''
    },
  }
}
