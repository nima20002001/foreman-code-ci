import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import { persistentFixtureRoot } from '../../../../test/helpers/fixtureStorage.js'
import { MainClock } from '../../devices/workerClock.js'
import { RemoteOperationJournal } from './operationJournal.js'

it.each([-90_000, 50_000, 90_000])(
  'uses Main elapsed time for reviewer retention and turns with a %s ms worker clock offset', async offset => {
    const root = await mkdtemp(join(persistentFixtureRoot, 'reviewer-clock-'))
    const mainTime = Date.now()
    let elapsed = 0
    const mainClock = new MainClock(() => elapsed)
    mainClock.observe(mainTime)
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(mainTime + offset)
    const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), {
      initializeNewInstallation: true, now: () => mainClock.now(),
    })
    const digest = 'a'.repeat(64)
    const intent: DispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId: randomUUID(),
      runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
      technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: digest,
      inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } }
    const connection = { mainId: intent.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
    const native = { sessionId: 'session', turnId: 'turn', processIdentityDigest: digest }
    const policy = { agentId: 'reviewer', expiresAt: new Date(mainTime + 60_000).toISOString() }
    const assignment = { jobId: 'review-job', interactionId: 'interaction', reviewerAgentId: 'reviewer',
      correlationId: 'review:review-job', session: { harness: 'codex' as const,
        providerVersion: 'fixture', nativeSessionId: native.sessionId } }
    try {
      await journal.accept(intent, connection, randomUUID())
      await journal.reserveEntry(intent.operationId)
      await journal.acknowledgeStart(intent.operationId, native)
      await journal.reserveTurn(intent.operationId, { correlationId: 'execution:execution', promptDigest: digest })
      await journal.acknowledgeTurn(intent.operationId, native.turnId)
      await journal.markRunning(intent.operationId)
      await expect(journal.retainReviewer(intent.operationId, policy, {
        events: [], pendingInteractions: [], terminalTurn: { correlationId: 'execution:execution',
          providerId: native.turnId, result: { outcome: 'succeeded' } },
      })).resolves.toMatchObject({ retainedReviewer: policy })
      elapsed = 10_000
      wallClock.mockReturnValue(mainTime + 300_000)
      await expect(journal.reserveReviewTurn(intent.operationId, assignment, digest, -1))
        .resolves.toMatchObject({ reserved: true })
      const renewed = { ...policy, expiresAt: new Date(mainTime + 100_000).toISOString() }
      elapsed = 40_000
      await expect(journal.renewReviewer(intent.operationId, renewed))
        .resolves.toMatchObject({ retainedReviewer: renewed })
      const delayed = { ...policy, expiresAt: new Date(mainTime + 80_000).toISOString() }
      await expect(journal.renewReviewer(intent.operationId, delayed))
        .resolves.toMatchObject({ retainedReviewer: renewed })
      elapsed = 90_000
      wallClock.mockReturnValue(mainTime - 300_000)
      await expect(journal.reserveReviewTurn(intent.operationId, assignment, digest, -1))
        .resolves.toMatchObject({ reserved: true })
      elapsed = 100_000
      await expect(journal.reserveReviewTurn(intent.operationId, assignment, digest, -1))
        .rejects.toThrow('Reviewer lifetime unavailable')
      await expect(journal.renewReviewer(intent.operationId, renewed)).rejects.toThrow('renewal mismatch')
    } finally {
      wallClock.mockRestore()
      await journal.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
