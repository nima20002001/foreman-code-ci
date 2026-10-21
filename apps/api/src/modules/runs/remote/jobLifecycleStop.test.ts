import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteJobDispatchIntentSchema, type RemoteJobOwnerControl } from '@foreman-code/contracts/remote-job-execution'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { jobSupervisorIdentity } from '../../jobs/executor.js'
import type { PodmanJobSupervisor } from '../../jobs/executorPodman.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteJobExecutionHost } from './jobExecutionHost.js'

const roots: string[] = [], journals: RemoteOperationJournal[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'job-stop-replay-')); roots.push(root)
  const path = join(root, 'journal')
  const journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true }); journals.push(journal)
  const execution = jobExecution(), containerId = 'c'.repeat(64)
  const connection = { kind: 'main' as const, mainId: execution.acceptedSpec.target.mainId,
    mainInstallationId: execution.acceptedSpec.target.mainInstallationId!, bootId: randomUUID() }
  const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId: connection.mainId,
    executionId: execution.id, operationId: execution.operationId, attemptId: execution.attemptId,
    bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId, jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId } })
  await journal.jobAccept(intent, execution, connection, randomUUID())
  await journal.jobReserveEntry(intent.operationId)
  await journal.jobAcknowledgeLaunch(intent.operationId, { containerId, supervisorIdentity: jobSupervisorIdentity(execution), processIdentityDigest: '1'.repeat(64) })
  const state = { stopped: false }
  const stopExecution = vi.fn(async () => { state.stopped = true; return true })
  const supervisor = { stopExecution, removeExecution: vi.fn(async () => {}), reconcile: vi.fn(async () => ({ containerId, stopped: state.stopped,
    exitCode: state.stopped ? 137 : null, timedOut: false, execError: false, logGapPossible: true })) } as unknown as PodmanJobSupervisor
  const authorize = vi.fn(async () => {})
  const forbidden = vi.fn(async () => { throw new Error('No native relaunch or source preparation allowed') })
  const hostFor = (retained: RemoteOperationJournal) => new RemoteJobExecutionHost({ journal: retained, connection, incarnationId: randomUUID(),
    supervisor, authorize, source: { verify: forbidden }, inputs: { prepare: forbidden },
    appendLog: async () => {}, observeReceipt: async () => {}, collectOutputs: async () => {} })
  const command: RemoteJobOwnerControl = { schemaVersion: 1, protocolVersion: 1, commandId: 'original-stop',
    operationId: intent.operationId, attemptId: intent.attemptId, executionId: execution.id, bindingHash: intent.bindingHash,
    subject: intent.subject, owner: intent.owner, action: { kind: 'stop' } }
  return { path, journal, execution, containerId, intent, command, stopExecution, authorize, forbidden, hostFor }
}

describe('persisted original Job Stop recovery', () => {
  it('retries a failed physical Stop after reopening without recording another command', async () => {
    const f = await fixture()
    f.stopExecution.mockRejectedValueOnce(new Error('physical Stop transport failed'))
    await expect(f.hostFor(f.journal).handle({ method: 'job-control', intent: f.intent, command: f.command })).rejects.toThrow('physical Stop transport failed')
    await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    const host = f.hostFor(reopened)
    await host.handle({ method: 'job-control', intent: f.intent, command: f.command })
    expect(f.stopExecution).toHaveBeenCalledTimes(2)
    expect(f.stopExecution).toHaveBeenLastCalledWith(f.execution, f.execution.acceptedSpec.policy.cancellationGraceMs, f.containerId)
    const status = await reopened.jobStatus(f.intent.operationId)
    expect(status.status === 'known' && status.receipt.controls).toEqual([f.command])
    expect(status.status === 'known' && status.receipt.terminal?.outcome).toBe('cancelled')
    await host.handle({ method: 'job-control', intent: f.intent, command: f.command })
    expect(f.stopExecution).toHaveBeenCalledTimes(2)
    expect(f.forbidden).not.toHaveBeenCalled()
  })
  it('recovery dispatches a persisted Stop after a crash before physical dispatch, without Main IO', async () => {
    const f = await fixture(); await f.journal.jobControl(f.command); await f.journal.close()
    const reopened = await RemoteOperationJournal.open(f.path); journals.push(reopened)
    await f.hostFor(reopened).recover()
    expect(f.stopExecution).toHaveBeenCalledExactlyOnceWith(f.execution, f.execution.acceptedSpec.policy.cancellationGraceMs, f.containerId)
    expect(f.authorize).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled()
  })
  it('status reconciliation retries the persisted Stop without a new control RPC', async () => {
    const f = await fixture(); await f.journal.jobControl(f.command)
    const status = await f.hostFor(f.journal).handle({ method: 'job-status', intent: f.intent })
    expect(f.stopExecution).toHaveBeenCalledOnce()
    expect(status.status === 'known' && status.receipt.terminal?.processStopped).toBe(true)
    expect(f.forbidden).not.toHaveBeenCalled()
  })
})
