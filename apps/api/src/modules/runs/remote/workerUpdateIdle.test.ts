import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteJobDispatchIntent } from '@foreman-code/contracts/remote-job-execution'
import { privateFixtureDirectory } from '../../../../test/helpers/privateFixtureDirectory.js'
import { jobExecution } from '../../../../test/helpers/jobFixture.js'
import { RemoteOperationJournal } from './operationJournal.js'

it.each(['received', 'entry-reserved', 'native-retry'] as const)(
  'allows updates with a durable %s workflow retry and preserves it across restart', async phase => {
    const directory = await privateFixtureDirectory('worker-update-idle-')
    const path = join(directory, 'operations.json')
    const digest = 'a'.repeat(64)
    const intent: DispatchIntent = {
      schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(), runId: 'run', nodeId: 'node',
      executionId: 'execution', occurrenceId: 'occurrence', occurrenceIndex: 0, technicalAttempt: 1,
      attemptId: 'attempt', operationId: 'operation', bindingHash: digest, inputDigest: `sha256:${digest}`,
      owner: { grantId: 'grant', epoch: '1' },
    }
    const connection = {
      mainId: intent.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1,
    }
    let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
    try {
      await journal.accept(intent, connection, randomUUID())
      if (phase !== 'received') await journal.reserveEntry(intent.operationId)
      if (phase === 'native-retry') {
        await journal.acknowledgeStart(intent.operationId, {
          sessionId: 'session', turnId: 'turn', processIdentityDigest: digest,
        })
      }
      const retained = await journal.status(intent.operationId)
      expect(await journal.isRuntimeQuiescent()).toBe(false)
      expect(await journal.isWorkerUpdateIdle()).toBe(true)
      const launch = {
        owner: `execution:${intent.executionId}`, launchId: randomUUID(), bootId: connection.bootId,
        lifecycle: 'active' as const,
      }
      expect(await journal.isWorkerUpdateIdle([launch])).toBe(false)
      expect(await journal.isWorkerUpdateIdle([{ ...launch, lifecycle: 'closure-unconfirmed' }])).toBe(false)
      expect(await journal.isWorkerUpdateIdle([{
        ...launch, lifecycle: 'closed', closureEvidence: 'native_not_started',
      }])).toBe(true)
      await journal.close()
      journal = await RemoteOperationJournal.open(path)
      expect(await journal.status(intent.operationId)).toEqual(retained)
      expect(await journal.isWorkerUpdateIdle()).toBe(true)
    } finally {
      await journal.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

it('allows updates with an unentered Job publication retry without retiring its receipt', async () => {
  const directory = await privateFixtureDirectory('worker-update-job-idle-')
  const path = join(directory, 'operations.json')
  const execution = jobExecution()
  const intent: RemoteJobDispatchIntent = {
    schemaVersion: 1, protocolVersion: 1, mainId: execution.acceptedSpec.target.mainId,
    subject: { kind: 'manual-job', workspaceId: execution.workspaceId,
      jobExecutionId: execution.id, definitionId: execution.acceptedSpec.definitionId },
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
    bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`,
    owner: execution.owner,
  }
  let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
  try {
    await journal.jobAccept(intent, execution, {
      kind: 'main', mainId: intent.mainId,
      mainInstallationId: execution.acceptedSpec.target.mainInstallationId, bootId: randomUUID(),
    }, randomUUID())
    const retained = await journal.jobStatus(intent.operationId)
    expect(await journal.isRuntimeQuiescent()).toBe(false)
    expect(await journal.isWorkerUpdateIdle()).toBe(true)
    await journal.close()
    journal = await RemoteOperationJournal.open(path)
    expect(await journal.jobStatus(intent.operationId)).toEqual(retained)
    expect(await journal.isWorkerUpdateIdle()).toBe(true)
  } finally {
    await journal.close()
    await rm(directory, { recursive: true, force: true })
  }
})
