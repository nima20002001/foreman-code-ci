const prefix = '[integration-startup] '

export function recordIntegrationStartup(phase, details = {}, environment = process.env) {
  const started = Number(environment.FOREMAN_CODE_TEST_FILE_STARTED_AT)
  if (!Number.isFinite(started) || started <= 0) return
  process.stdout.write(`${prefix}${JSON.stringify({ phase, elapsedMs: Date.now() - started, ...details })}\n`)
}

export function readIntegrationStartup(output) {
  const phases = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue
    try {
      const phase = JSON.parse(line.slice(prefix.length))
      if (typeof phase.phase === 'string' && Number.isFinite(phase.elapsedMs) && phase.elapsedMs >= 0) {
        phases.push(phase)
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return phases
}
