import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RemoteJobDispatchIntentSchema, type RemoteJobOwnerControl } from '@foreman-code/contracts/remote-job-execution'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { RemoteOperationJournal } from './operationJournal.js'

const roots: string[] = []
const journals: RemoteOperationJournal[] = []
afterEach(async () => {
  await Promise.all(journals.splice(0).map(journal => journal.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'job-cancellation-'))
  roots.push(root)
  const path = join(root, 'journal')
  const journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
  journals.push(journal)
  const execution = jobExecution()
  const connection = { kind: 'main' as const, mainId: execution.acceptedSpec.target.mainId,
    mainInstallationId: execution.acceptedSpec.target.mainInstallationId!, bootId: randomUUID() }
  const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1,
    mainId: connection.mainId, executionId: execution.id, operationId: execution.operationId,
    attemptId: execution.attemptId, bindingHash: execution.acceptedSpec.bindingHash,
    inputDigest: `sha256:${execution.acceptedSpec.specDigest}`, owner: execution.owner,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId,
      jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId } })
  const command: RemoteJobOwnerControl = { schemaVersion: 1, protocolVersion: 1, commandId: randomUUID(),
    operationId: intent.operationId, attemptId: intent.attemptId, executionId: execution.id,
    bindingHash: intent.bindingHash, subject: intent.subject, owner: intent.owner, action: { kind: 'stop' } }
  const terminal = { outcome: 'cancelled' as const, exitCode: null, signal: null, processStopped: true as const,
    finishedAt: new Date().toISOString(), closureEvidenceDigest: '1'.repeat(64), resultDigest: '2'.repeat(64),
    logGapPossible: false, logsTruncated: false, outputCollectionError: false, artifactDigests: [] }
  return { journal, path, execution, connection, intent, command, terminal }
}

it('persists a stop fence for an absent original Job before any later entry can be reserved', async () => {
  const f = await fixture()
  const receipt = await f.journal.jobCancelBeforeEntry(f.intent, f.execution, f.connection, randomUUID(), f.command, f.terminal)
  expect(receipt).toMatchObject({ entryAttempted: false, stopFence: true, controls: [f.command] })
  expect((await f.journal.jobReserveEntry(f.intent.operationId)).reserved).toBe(false)
  await f.journal.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  journals.push(reopened)
  expect((await reopened.jobReserveEntry(f.intent.operationId)).reserved).toBe(false)
  expect((await reopened.jobStatus(f.intent.operationId)).status).toBe('known')
})

it('rejects an attempted OCI entry instead of manufacturing no-entry closure', async () => {
  const f = await fixture()
  await f.journal.jobAccept(f.intent, f.execution, f.connection, randomUUID())
  await f.journal.jobReserveEntry(f.intent.operationId)
  await expect(f.journal.jobCancelBeforeEntry(f.intent, f.execution, f.connection, randomUUID(), f.command, f.terminal))
    .rejects.toThrow('entry')
  const status = await f.journal.jobStatus(f.intent.operationId)
  expect(status.status === 'known' && status.receipt.stopFence).toBe(false)
})

it('rejects a mismatched stop command without leaving an accepted operation', async () => {
  const f = await fixture()
  await expect(f.journal.jobCancelBeforeEntry(f.intent, f.execution, f.connection, randomUUID(),
    { ...f.command, attemptId: 'another-attempt' }, f.terminal)).rejects.toThrow('ownership')
  expect((await f.journal.jobStatus(f.intent.operationId)).status).toBe('unknown')
})
