import { describe, expect, it } from 'vitest'
import {
  JobPendingAdmissionSchema, JobQueueTicketSchema, JobQueuedStartSchema, JobResourceReservationSchema,
  JobComputerEligibilitySchema, JobComputerSelectionRequestSchema, JOB_COMPUTER_ORDER, JOB_QUEUE_ORDER,
  JobAvailableCapacitySchema,
  JobBuildQueueConfigurationSchema,
  JobAdmissionResultSchema,
  JobLaunchValidationInputSchema, JobLaunchValidationSchema,
} from './jobAdmission.js'
import { AutoJobDefinitionSpecSchema, jobPolicyRequirements, AcceptedJobSpecSchema } from './jobs.js'
import { verificationFixture, verificationId, verificationTime, verificationDigest } from '../tests/helpers/jobVerification.js'

describe('pending Job admission', () => {
  it('retains the author’s grant ceiling for preparation and rejects another principal', () => {
    const { ticket } = verificationFixture()
    const runtimePreparation = { id: ticket.principalId, name: 'Ticket author', audience: 'operator',
      grants: [{ actions: ['job_artifacts:read'], scope: { workspaceIds: [ticket.workspaceId] } }],
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
    expect(JobQueueTicketSchema.parse({ ...ticket, runtimePreparation }).runtimePreparation).toEqual(runtimePreparation)
    expect(JobQueueTicketSchema.safeParse({ ...ticket, runtimePreparation: { ...runtimePreparation, id: 'another-author' } })
      .success).toBe(false)
    expect(JobQueuedStartSchema.safeParse({ commandId: 'start', definitionId: 'definition', expectedRevision: 1,
      runtimePreparation }).success).toBe(false)
  })
  it('validates the launch revision and placement separately from current readiness', () => {
    const { build } = verificationFixture()
    const input = { definitionId: 'build', expectedRevision: 1,
      placementOverride: { kind: 'explicit', target: build.target } }
    expect(JobLaunchValidationInputSchema.parse(input)).toEqual(input)
    expect(JobLaunchValidationInputSchema.safeParse({ ...input, expectedRevision: 0 }).success).toBe(false)
    expect(JobLaunchValidationSchema.parse({ valid: false, canQueue: true,
      reasons: ['offline'], sideEffects: false })).toMatchObject({ valid: false, canQueue: true })
    expect(JobLaunchValidationSchema.safeParse({ valid: false, reasons: ['offline'], sideEffects: false }).success)
      .toBe(false)
  })
  it('reads a retained concrete execution without fabricating a queue ticket or widening accepted placement', () => {
    const { acceptedBuild, ticket } = verificationFixture()
    const execution = { schemaVersion: 1, id: ticket.executionId, workspaceId: ticket.workspaceId,
      acceptedSpec: acceptedBuild, operationId: ticket.operationId, attemptId: ticket.attemptId,
      owner: { grantId: verificationId, epoch: '1' }, workflow: null,
      process: { phase: 'queued', outcome: null, exitCode: null, signal: null, processStopped: false },
      transport: 'unknown', publication: 'pending', startedAt: null, finishedAt: null, lastSeenAt: null,
      resultIssue: null, cancelRequestedAt: null, createdAt: verificationTime, updatedAt: verificationTime }
    expect(JobAdmissionResultSchema.parse({ kind: 'retained-execution', execution }))
      .toEqual({ kind: 'retained-execution', execution })
    expect(JobAdmissionResultSchema.safeParse({ kind: 'retained-execution', execution: { ...execution,
      acceptedSpec: { ...acceptedBuild, target: { kind: 'auto' } } } }).success).toBe(false)
  })
  it('retains an unresolved Auto ticket before preparation without making accepted execution unresolved', () => {
    const { build, resources, ticket, acceptedBuild } = verificationFixture()
    const spec = AutoJobDefinitionSpecSchema.parse({
      ...build, target: { kind: 'auto' }, policy: jobPolicyRequirements(build.policy), limits: resources.limits,
    })
    const pending = { kind: 'pending-admission', ticket: {
      ...ticket, definition: { ...ticket.definition, spec }, placement: { kind: 'auto' },
    } }
    expect(JobPendingAdmissionSchema.parse(pending)).toEqual(pending)
    expect(JobPendingAdmissionSchema.safeParse({ ...pending, acceptedSpec: acceptedBuild }).success).toBe(false)
    expect(AcceptedJobSpecSchema.safeParse({ ...acceptedBuild, target: { kind: 'auto' } }).success).toBe(false)
    expect(JobPendingAdmissionSchema.safeParse({ kind: 'pending-admission', ticket: {
      ...ticket, state: 'accepted', reservationId: verificationId,
    } }).success).toBe(false)
  })
  it('records a Start placement override without editing the saved default or resetting its deadline', () => {
    const { ticket } = verificationFixture()
    const override = { kind: 'auto' }
    expect(JobQueueTicketSchema.parse({ ...ticket, placement: override, placementOverride: override }).definition)
      .toEqual(ticket.definition)
    expect(JobQueueTicketSchema.safeParse({ ...ticket, placement: override }).success).toBe(false)
    expect(JobQueueTicketSchema.safeParse({ ...ticket, deadlineAt: '2026-10-04T12:02:00.000Z' }).success).toBe(false)
    expect(JobQueueTicketSchema.safeParse({ ...ticket, workspaceId: 'foreign-workspace' }).success).toBe(false)
  })
  it('reads selected-computer and pending-cleanup facts while retaining historical tickets without a projection', () => {
    const { ticket, build } = verificationFixture()
    const selectedComputer = { target: build.target, rootId: verificationId, bindingRevision: 1,
      profileId: build.policy.isolationPolicyId, profileRevision: build.policy.isolationPolicyRevision }
    const claimed = { ...ticket, state: 'claimed', reservationId: verificationId, selectedComputer, cleanupStatus: 'none' }
    expect(JobQueueTicketSchema.parse(claimed)).toMatchObject({ selectedComputer, cleanupStatus: 'none' })
    expect(JobQueueTicketSchema.parse({ ...claimed, state: 'terminal', terminalReason: 'cancelled',
      cancelRequestedAt: verificationTime, finishedAt: verificationTime, cleanupStatus: 'pending' }))
      .toMatchObject({ selectedComputer, cleanupStatus: 'pending' })
    expect(JobQueueTicketSchema.parse(ticket)).toEqual(ticket)
    expect(JobQueueTicketSchema.safeParse({ ...claimed, selectedComputer: { ...selectedComputer,
      profileRevision: 0 } }).success).toBe(false)
  })
  it('rejects ambiguous placement, caller scheduling priority and unversioned claim data', () => {
    const start = { commandId: 'start', definitionId: 'definition', expectedRevision: 1 }
    expect(JobQueuedStartSchema.parse(start)).toEqual(start)
    for (const placementOverride of [{ kind: 'auto', deviceId: verificationId }, { kind: 'explicit' }, { kind: 'main' }]) {
      expect(JobQueuedStartSchema.safeParse({ ...start, placementOverride }).success).toBe(false)
    }
    const { ticket } = verificationFixture()
    expect(JobQueueTicketSchema.safeParse({ ...ticket, priority: 100 }).success).toBe(false)
    expect(JobQueueTicketSchema.safeParse({ ...ticket, state: 'claimed' }).success).toBe(false)
    expect(JobQueueTicketSchema.safeParse({ ...ticket, expectedRevision: 0 }).success).toBe(false)
  })
  it('requires persisted terminal cancellation facts for an unclaimed ticket', () => {
    const { ticket } = verificationFixture()
    const cancelled = { ...ticket, state: 'terminal', terminalReason: 'cancelled',
      cancelRequestedAt: verificationTime, finishedAt: verificationTime }
    expect(JobQueueTicketSchema.parse(cancelled).reservationId).toBeNull()
    expect(JobQueueTicketSchema.safeParse({ ...cancelled, cancelRequestedAt: null }).success).toBe(false)
  })
  it('retains a completed execution ticket with its original claim and completion time', () => {
    const { ticket } = verificationFixture()
    const completed = { ...ticket, state: 'terminal', terminalReason: 'completed',
      reservationId: ticket.id, finishedAt: ticket.enqueuedAt, queuePosition: null }
    expect(JobQueueTicketSchema.parse(completed)).toMatchObject(completed)
    expect(JobQueueTicketSchema.safeParse({ ...completed, reservationId: null }).success).toBe(false)
  })
})

describe('shared computer selection contract', () => {
  it('separates computer preference from FIFO and requires scoped immutable selector inputs', () => {
    const { ticket } = verificationFixture()
    const request = {
      schemaVersion: 1, workspaceId: ticket.workspaceId, principalId: ticket.principalId,
      definitionId: ticket.definition.id, definitionRevision: ticket.definition.revision,
      definitionVersionId: ticket.definition.versionId, executionId: ticket.executionId,
      attemptId: ticket.attemptId, operationId: ticket.operationId, spec: ticket.definition.spec,
      placement: ticket.placement, resources: ticket.resources, queueOrder: JOB_QUEUE_ORDER, computerOrder: JOB_COMPUTER_ORDER,
    }
    expect(JobComputerSelectionRequestSchema.parse(request)).toEqual(request)
    expect(JobComputerSelectionRequestSchema.safeParse({ ...request, queueOrder: 'build-priority' }).success).toBe(false)
    expect(JobComputerSelectionRequestSchema.safeParse({ ...request, ready: true }).success).toBe(false)
    expect(JobComputerSelectionRequestSchema.safeParse({ ...request, principalId: '' }).success).toBe(false)
  })
  it('cannot make a preferred computer available by bypassing qualification, authority or capacity', () => {
    const { build } = verificationFixture()
    const ready = { target: build.target, compatible: true, eligible: true, available: true, reasons: [],
      buildPriority: 100, settingsRevision: 1, rootId: verificationId, bindingRevision: 1,
      profileId: 'profile', profileRevision: 1 }
    expect(JobComputerEligibilitySchema.parse(ready)).toEqual(ready)
    for (const reason of ['busy', 'disabled', 'suite_unqualified', 'network_unavailable', 'authorization_revoked']) {
      expect(JobComputerEligibilitySchema.safeParse({ ...ready, reasons: [reason] }).success).toBe(false)
    }
    expect(JobComputerEligibilitySchema.parse({ ...ready, available: false, reasons: ['busy'] }).eligible).toBe(true)
    expect(JobComputerEligibilitySchema.safeParse({ ...ready, eligible: false }).success).toBe(false)
  })
})

describe('resource reservation closure', () => {
  it('represents a saturated computer without weakening the positive measured maximum', () => {
    const { resources } = verificationFixture()
    const capacity = { maximum: resources.limits,
      available: { cpuLimit: 0, memoryBytes: 0, pidsLimit: 0, diskBytes: 0 },
      controlReserveApplied: true, availableHeavySlots: 0,
      maximumMutableInodes: resources.mutableInodes, availableMutableInodes: 0 }
    expect(JobAvailableCapacitySchema.parse(capacity)).toEqual(capacity)
    expect(JobAvailableCapacitySchema.safeParse({ ...capacity, controlReserveApplied: false }).success).toBe(false)
    expect(JobAvailableCapacitySchema.safeParse({ ...capacity,
      available: { ...capacity.available, cpuLimit: resources.limits.cpuLimit + 1 } }).success).toBe(false)
  })
  it('holds uncertain delivery and retains disk after confirmed descendants close until cleanup', () => {
    const { reservation } = verificationFixture()
    const uncertain = { ...reservation, state: 'execution-uncertain', deliveryAttemptedAt: verificationTime }
    expect(JobResourceReservationSchema.parse(uncertain).computeReleasedAt).toBeNull()
    expect(JobResourceReservationSchema.safeParse({ ...uncertain, computeReleasedAt: verificationTime }).success).toBe(false)
    const closed = { ...reservation, state: 'retained', deliveryAttemptedAt: verificationTime,
      closure: { kind: 'descendants-closed', observedAt: verificationTime, evidenceDigest: verificationDigest },
      computeReleasedAt: verificationTime }
    expect(JobResourceReservationSchema.parse(closed).storageReleasedAt).toBeNull()
    expect(JobResourceReservationSchema.safeParse({ ...closed, storageReleasedAt: verificationTime }).success).toBe(false)
    expect(JobResourceReservationSchema.parse({ ...closed, state: 'released',
      cleanupCompletedAt: verificationTime, storageReleasedAt: verificationTime }).state).toBe('released')
  })
})

describe('reviewed build queue configuration', () => {
  it('requires explicit owner review, positive revisions and bounded unambiguous resource envelopes without defaults', () => {
    const { resources } = verificationFixture()
    const configuration = {
      schemaVersion: 1, mainId: verificationId, revision: 1,
      limits: { maxPendingPerPrincipal: 5, maxPendingPerWorkspace: 10, maxBackfillClaims: 0 },
      envelopes: [resources], review: {
        reviewedByPrincipalId: 'owner', reviewedAt: verificationTime, decisionDigest: verificationDigest,
      },
    }
    expect(JobBuildQueueConfigurationSchema.parse(configuration)).toEqual(configuration)
    expect(JobBuildQueueConfigurationSchema.safeParse({}).success).toBe(false)
    expect(JobBuildQueueConfigurationSchema.safeParse({ ...configuration, review: null }).success).toBe(false)
    expect(JobBuildQueueConfigurationSchema.safeParse({ ...configuration, revision: 0 }).success).toBe(false)
    expect(JobBuildQueueConfigurationSchema.safeParse({ ...configuration, envelopes: [resources, resources] }).success).toBe(false)
    expect(JobBuildQueueConfigurationSchema.safeParse({ ...configuration,
      limits: { ...configuration.limits, maxPendingPerPrincipal: 0 } }).success).toBe(false)
    expect(JobBuildQueueConfigurationSchema.safeParse({ ...configuration,
      envelopes: [{ ...resources, scratchBytes: resources.limits.diskBytes }] }).success).toBe(false)
  })
})
