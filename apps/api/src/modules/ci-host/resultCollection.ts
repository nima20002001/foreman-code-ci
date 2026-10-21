import type pg from 'pg'
import type { CiHostReply, CiHostRun, CiRunRecord } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import { serializeCiJson } from './text.js'
import { ciExecutionRunId } from './executionAttempt.js'
import { gunzipSync } from 'node:zlib'
import { CiIntegrationCoverageSchema } from '@foreman-code/contracts'
import type { IntegrationCoverageStore } from './coverageStore.js'
import { expandIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'

const log = componentLogger('jobs')

export async function collectCiResults(pool: pg.Pool, endpoint: HostCiEndpoint, computer: HostCiComputer,
  run: CiRunRecord, reply: Extract<CiHostReply, { operation: 'read' }>, coverage?: IntegrationCoverageStore) {
  if (!['unit', 'integration'].includes(run.suite)) {
    return { run: reply.run, durations: reply.durations, error: undefined }
  }
  let results: Extract<CiHostReply, { operation: 'read' }> | undefined
  let collection: CiHostRun['collection'] = 'pending'
  let collectionError: unknown
  try {
    const fetched = await endpoint.request(computer, { operation: 'read', runId: ciExecutionRunId(run),
      afterOffset: 0, maxBytes: 1, testResults: true, durations: true,
      ...(coverage && run.suite === 'integration' && run.scope === 'full' ? { integrationCoverage: true } : {}) },
    { priority: 'background' })
    if (fetched.operation === 'read') {
      results = fetched
      if (coverage && fetched.integrationCoverage && run.suite === 'integration' && run.scope === 'full') {
        const report = CiIntegrationCoverageSchema.parse(expandIntegrationCoverage(JSON.parse(
          gunzipSync(Buffer.from(fetched.integrationCoverage, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString())))
        await coverage.record(run.repository, run.commit, report)
      }
      if (fetched.testResults) {
        await pool.query(`update ci_runs set test_results=$2::jsonb where id=$1
          and coalesce(record->>'executionRunId',record#>>'{setupRetry,runId}',id::text)=$3`,
        [run.id, serializeCiJson(fetched.testResults), ciExecutionRunId(run)])
        collection = fetched.run.collection === 'pending' ? 'pending' : 'complete'
      } else if (fetched.run.collection === 'unsupported' || fetched.run.collection === 'failed') {
        collection = fetched.run.collection
      }
    }
  } catch (error) {
    const unsupported = error instanceof DomainError && (error.code === 'CI_TEST_RESULTS_UNSUPPORTED'
      || error.status === 400 && /testResults/.test(error.message))
    if (unsupported) collection = 'unsupported'
    else {
      collectionError = error
      log.warn({ err: error, runId: run.id }, 'CI result collection remains pending')
    }
  }
  return { run: { ...reply.run, collection }, durations: results?.durations ?? reply.durations,
    error: collectionError }
}
