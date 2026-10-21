import { harnessBinaries } from '../modules/harnesses/binaries.js'
import { createHarnessCompatibility } from '../modules/harnesses/compatibility/service.js'

// Deliberately does not load ApiConfig: building needs neither DB nor owner secrets.
const service = createHarnessCompatibility({
  ...harnessBinaries(process.env),
  workspaceRoot: process.env.HARNESS_WORKSPACE_ROOT?.trim() || '/tmp/graphql-harness-runs',
})
try {
  const reports = await service.checkAll()
  for (const report of reports) {
    console.info(`[harness compatibility] ${report.harness}: installed=${report.installedVersion ?? 'unavailable'}; ${report.status}`)
    if (report.reason) console.warn(`${report.reason.code}: ${report.reason.message}`)
    if (report.cacheWarning) console.warn(report.cacheWarning)
  }
  console.info('Installed versions are checked against runtime protocol contracts. Authentication, selected model/settings, approval policy and host sandbox checks still apply.')
} finally { await service.close() }
