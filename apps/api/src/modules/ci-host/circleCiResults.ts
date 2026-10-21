import { z } from 'zod'
import {
  CI_TEST_RESULT_LIMITS, CiTestResultsSchema, CiTestSummarySchema, type CiTestResults,
} from '@foreman-code/contracts'
import { sanitizeCiText } from './text.js'

const IntegrationSummarySchema = z.object({
  schemaVersion: z.literal(1),
  suite: z.literal('integration'),
  totals: CiTestSummarySchema.strip().optional(),
  files: z.array(z.object({
    file: z.string().min(1),
    code: z.number().int().nullable(),
    complete: z.boolean(),
    elapsedMs: z.number().nonnegative().finite().optional(),
  })),
})

/** A process failure can leave no Vitest assertions, or only passing ones. Retests do not replace that first pass. */
export function circleCiIntegrationResults(results: unknown, summary: unknown) {
  if (summary === null) return results
  const report = IntegrationSummarySchema.parse(summary)
  const tests: CiTestResults = results === null
    ? { summary: report.totals ?? { passed: 0, failed: 0, skipped: 0 }, files: [], truncated: false }
    : CiTestResultsSchema.parse(results)
  const files = new Map(tests.files.map(file => [file.file, file]))
  for (const result of report.files) {
    const file = sanitizeCiText(result.file).slice(0, CI_TEST_RESULT_LIMITS.file)
    const status = result.code === 0 && result.complete ? 'passed' : 'failed'
    const recorded = files.get(file)
    if (recorded) {
      if (status === 'failed') files.set(file, { ...recorded, status })
    } else {
      files.set(file, { file, status, tests: [],
        durationMs: result.elapsedMs === undefined ? null : Math.min(result.elapsedMs, 24 * 3_600_000) })
    }
  }
  const rank = { failed: 0, skipped: 1, passed: 2 }
  const sorted = [...files.values()].sort((left, right) => rank[left.status] - rank[right.status]
    || left.file.localeCompare(right.file))
  return CiTestResultsSchema.parse({ ...tests, files: sorted.slice(0, CI_TEST_RESULT_LIMITS.files),
    truncated: tests.truncated || sorted.length > CI_TEST_RESULT_LIMITS.files })
}
