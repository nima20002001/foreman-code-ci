import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobLogChunk } from '@foreman-code/contracts/jobs'
import { RemoteJobDispatchIntentSchema, type RemoteJobOperationReceiptRecord } from '@foreman-code/contracts/remote-job-execution'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { executeJob, jobSupervisorIdentity } from '../../jobs/executor.js'
import type { PodmanJobSupervisor } from '../../jobs/executorPodman.js'
import { deriveJobReceiptLocked } from '../../jobs/receiptProjection.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteJobExecutionHost } from './jobExecutionHost.js'
import { readOperationalFailures } from '../../diagnostics/logger.js'

vi.mock('../../jobs/executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../jobs/executor.js')>(), executeJob: vi.fn(),
}))
const roots: string[] = [], journals: RemoteOperationJournal[] = [], hosts: RemoteJobExecutionHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.drain()))
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.clearAllMocks()
})

// Actual durable host/spool/publication path; the bounded executor is a unit double.
async function fixture(failLog: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'job-final-log-')); roots.push(root)
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true }); journals.push(journal)
  const execution = jobExecution()
  const connection = { kind: 'main' as const, mainId: execution.acceptedSpec.target.mainId,
    mainInstallationId: execution.acceptedSpec.target.mainInstallationId!, bootId: randomUUID() }
  const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId: connection.mainId,
    executionId: execution.id, operationId: execution.operationId, attemptId: execution.attemptId, owner: execution.owner,
    bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId } })
  const chunk: JobLogChunk = { executionId: execution.id, attemptId: execution.attemptId, sequence: 1,
    stream: 'stdout', text: 'final stdout', byteSize: 12, createdAt: new Date().toISOString() }
  vi.mocked(executeJob).mockImplementation(async (current, ports) => {
    const name = jobSupervisorIdentity(current)
    expect(await ports.authority.claim(current, name)).toBe('launch')
    await ports.authority.launched(current, name, 'c'.repeat(64))
    await ports.appendLog(chunk)
    return { outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true, supervisorIdentity: name,
      containerId: 'c'.repeat(64), recoveryRequired: false, logError: false, logsTruncated: false, outputCollectionError: false }
  })
  const state = { released: false, latest: undefined as RemoteJobOperationReceiptRecord | undefined }
  const appendLog = vi.fn(async () => { if (state.released) throw new Error('original Main owner retired') })
  if (failLog) appendLog.mockRejectedValueOnce(new Error('final stdout transport failed'))
  const forbidden = vi.fn(async () => { throw new Error('No source or input I/O in executor unit double') })
  const collectOutputs = vi.fn(async () => {})
  const host = new RemoteJobExecutionHost({ journal, connection, incarnationId: randomUUID(), supervisor: { removeExecution: vi.fn(async () => {}) } as unknown as PodmanJobSupervisor,
    source: { verify: forbidden }, inputs: { prepare: forbidden }, authorize: async () => {}, appendLog, collectOutputs,
    observeReceipt: async receipt => { state.latest = receipt; if (receipt.publication === 'complete') state.released = true },
  }); hosts.push(host)
  await host.deliver(intent, execution); await host.drain()
  if (!state.latest) throw new Error('Terminal/output receipt was not observed')
  return { journal, execution, intent, chunk, appendLog, host, collectOutputs, state, receipt: state.latest }
}

describe('terminal completion with durable log delivery', () => {
  it('reports the unresolved original chunk after final log failure and successful no-output completion', async () => {
    const f = await fixture(true)
    expect(f.receipt.publication).toBe('complete'); expect(f.receipt.terminal?.processStopped).toBe(true)
    expect(f.receipt.terminal?.logGapPossible).toBe(true)
    const projected = await deriveJobReceiptLocked({ query: vi.fn() }, f.execution, f.receipt, { verifyRequiredOutputs: async () => {} })
    expect(projected.resultIssue).toBe('log_delivery_unknown')
    expect(await f.journal.jobPendingLogs(f.intent.operationId)).toEqual([f.chunk])
    expect(readOperationalFailures()).toContainEqual(expect.objectContaining({ operation: 'flush remote job log spool',
      pendingBytes: f.chunk.byteSize, pendingSince: f.chunk.createdAt }))
    // Transport is restored, but Main has retired ownership. The gap must stay explicit.
    await f.host.handle({ method: 'job-status', intent: f.intent })
    expect(f.appendLog).toHaveBeenLastCalledWith(f.chunk)
    expect(await f.journal.jobPendingLogs(f.intent.operationId)).toEqual([f.chunk])
    expect(vi.mocked(executeJob)).toHaveBeenCalledOnce(); expect(f.collectOutputs).toHaveBeenCalledOnce()
  })
  it('does not report a gap when Main acknowledges the final original chunk', async () => {
    const f = await fixture(false)
    expect(f.receipt.terminal?.logGapPossible).toBe(false)
    expect(await f.journal.jobPendingLogs(f.intent.operationId)).toEqual([])
    expect(f.appendLog).toHaveBeenCalledExactlyOnceWith(f.chunk)
  })
})
