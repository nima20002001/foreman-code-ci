import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readReport, reportPaths } from './verification-reports.mjs'
import { validateVerificationContext, finalizeVerification, verifyRepository } from './verification-runner.mjs'
export * from './verification-runner.mjs'

async function main(argv) {
  const repository = process.cwd()
  if (argv[0] !== '--context' || !argv[1] || ![2, 4].includes(argv.length)
    || (argv.length === 4 && (argv[2] !== '--finalize'
      || !['cancelled', 'timed_out', 'failed', 'incomplete'].includes(argv[3])))) {
    throw new Error('Usage: verify-repository.mjs --context <trusted JSON> [--finalize <terminal outcome>]')
  }
  const context = validateVerificationContext(JSON.parse(readReport(resolve(argv[1]), 1024 * 1024)))
  let summary
  if (argv[2] === '--finalize') {
    const directory = resolve(repository, dirname(reportPaths.summary))
    const state = JSON.parse(readReport(join(directory, 'parts', 'state.json'), context.limits.vitestBytes))
    if (JSON.stringify(state.identity) !== JSON.stringify(context.identity)) throw new Error('Finalization identity mismatch')
    // The installed runtime invokes this mode only after positive container closure.
    summary = finalizeVerification(context, { root: repository, directory, state,
      terminalOutcome: argv[3], processStopped: true })
  } else {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.on('SIGINT', cancel)
    process.on('SIGTERM', cancel)
    try { summary = await verifyRepository(context, { root: repository, signal: controller.signal }) }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel) }
  }
  console.log(JSON.stringify({ outcome: summary.outcome, completeness: summary.completeness, totals: summary.totals }))
  process.exitCode = summary.outcome === 'passed' ? 0 : summary.outcome === 'timed_out' ? 124 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(`[verification] ${error.message}`); process.exitCode = 1 })
}
