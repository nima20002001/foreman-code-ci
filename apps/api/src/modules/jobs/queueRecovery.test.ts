import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { JobDefinitionRecordSchema } from '@foreman-code/contracts/job-verification'
import { jobExecution } from '../../../test/helpers/jobFixture.js'
import { verificationFixture } from '../../../test/helpers/jobVerificationFixture.js'
import { JobRepository, type JobSql } from './repository.js'

it('completes a recovery batch without per-ticket database round trips', async () => {
  const execution = jobExecution()
  execution.process = { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true }
  execution.publication = 'complete'
  execution.finishedAt = execution.updatedAt
  const definition = JobDefinitionRecordSchema.parse({ schemaVersion: 1, id: 'definition',
    versionId: 'version', workspaceId: execution.workspaceId, name: 'Recovery', revision: 1,
    spec: verificationFixture().build, createdAt: execution.createdAt, updatedAt: execution.updatedAt })
  const ticket = JobQueueTicketSchema.parse({ schemaVersion: 1, id: randomUUID(), workspaceId: execution.workspaceId,
    revision: 1, commandId: 'command', commandDigest: 'a'.repeat(64), principalId: 'operator', definition,
    executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId,
    workflow: null, gateId: null, placement: { kind: 'explicit', target: definition.spec.target },
    placementOverride: null, resources: verificationFixture().resources,
    enqueueSequence: '1', enqueuedAt: execution.createdAt,
    deadlineAt: new Date(Date.parse(execution.createdAt) + definition.spec.policy.queueTimeoutMs).toISOString(),
    state: 'accepted', waitingReasons: [], compatibleTargetCount: 1, queuePosition: null, estimatedStartAt: null,
    reservationId: randomUUID(), cancelRequestedAt: null, terminalReason: null, finishedAt: null })
  const query = vi.fn(async () => ({ rows: [{ record: ticket, execution }], rowCount: 1 }))

  await new JobRepository().finishCompletedQueueTickets({ query } as unknown as JobSql)

  expect(query).toHaveBeenCalledTimes(1)
})
