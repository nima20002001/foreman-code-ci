import { rm } from 'node:fs/promises'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { AutoVerificationJobSpecSchema, JobExecutionRecordSchema, ResolvedVerificationJobSpecSchema,
  jobVerificationTemplate }
  from '@foreman-code/contracts/job-verification'
import { jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { JobQueuePreparation } from '../src/modules/jobs/preparation.js'
import { JobRepository } from '../src/modules/jobs/repository.js'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { compatibleJobComputer } from '../src/modules/jobs/computerSelection.js'
import { ciFixture } from './helpers/ciFixture.js'
import { ciPreparationFixture, commit, oldImage, newImage } from './helpers/ciPreparationFixture.js'
import { verificationFixture } from './helpers/jobVerificationFixture.js'
import { verificationRuntimeFixture } from './helpers/verificationRuntimeFixture.js'
import { jobExecution } from './helpers/jobFixture.js'

afterEach(() => vi.restoreAllMocks())

describe('CI preparation follows persisted queue state', () => {
  it('prepares after a delayed first scan, restarts the Worker and admits the original ticket with its resolved image', async () => {
    const stateDirectory = await privateFixtureDirectory('ci-queue-state-')
    const preparation = await ciPreparationFixture({ loseRefreshAck: true, stateDirectory })
    const ci = ciFixture({ initialWaitingReasons: [] })
    const before = preparation.profiles.get('p-unit')!
    const template = jobVerificationTemplate({ profileId: before.id, profileRevision: before.revision,
      suite: 'unit', ready: true, policy: before.spec.policy, resources: before.spec.resources, maxUnitWorkers: 1 })
    const saved = verificationFixture().spec
    const spec = AutoVerificationJobSpecSchema.parse({ ...saved,
      source: { ...saved.source, commit }, target: { kind: 'auto' },
      limits: template.resources.limits, policy: template.policy, runtimeSelection: 'qualified-profile',
      argv: template.argv, outputs: template.outputs,
      verification: { ...saved.verification, resources: template.resources, parameters: template.parameters },
    })
    const definition = await ci.jobs.saveDefinition(ci.operator, 'mcp', ci.workspaceId, {
      commandId: 'save-queued-ci', expectedRevision: null, name: 'Queued verification', spec,
    })
    const queued = await ci.jobs.enqueue(ci.operator, 'mcp', ci.workspaceId, {
      commandId: 'queued-ci', definitionId: definition.id, expectedRevision: definition.revision,
    }, { runtimePreparation: ci.operator })
    if (queued.kind !== 'pending-admission') throw new Error('Expected a queued verification ticket')
    let ticket = ci.ticket()
    const original = structuredClone(ticket)
    const admitted = vi.fn()
    const query = async (text: string, values?: unknown[]) => {
      if (text.includes('select limits from job_computer_selections')) return { rows: [{ limits: ticket.resources.limits }] }
      if (text.includes('select backfill_claims')) return { rows: [{ backfill_claims: 0 }] }
      if (text.includes('select created_at from job_preparations')) return { rows: [{ created_at: new Date() }] }
      return preparation.pool.query(text, values)
    }
    const pool = { query } as unknown as pg.Pool
    vi.spyOn(JobOwnership, 'acquire').mockImplementation(preparation.memory.acquire)
    vi.spyOn(JobRepository.prototype, 'pendingQueue').mockImplementation(async () =>
      ['waiting', 'blocked', 'claimed'].includes(ticket.state) ? [structuredClone(ticket)] : [])
    vi.spyOn(JobRepository.prototype, 'queueTicket').mockImplementation(async () => structuredClone(ticket))
    vi.spyOn(JobRepository.prototype, 'putQueueTicket').mockImplementation(async (_sql, value) => {
      ticket = JobQueueTicketSchema.parse({ ...value, revision: ticket.revision + 1 })
      return structuredClone(ticket)
    })
    const candidate = () => {
      const profile = preparation.profiles.get('p-unit')!
      const saved = verificationFixture().spec
      const spec = ResolvedVerificationJobSpecSchema.parse({ ...saved, source: ticket.definition.spec.source,
        argv: ticket.definition.spec.argv, outputs: ticket.definition.spec.outputs,
        verification: 'verification' in ticket.definition.spec ? ticket.definition.spec.verification : saved.verification,
        policy: jobRuntimeProfilePolicy(profile), target: { ...saved.target, hostRef: profile.root.selection.hostRef,
          registration: profile.root.registration } })
      return { profile, spec, ready: true, reasons: [], sourceReservation: { scopeId: 'fixture', reservedBytes: 1024 } }
    }
    const queue = new JobQueuePreparation(pool, {
      configuration: { revision: 1, review: { reviewedByPrincipalId: ci.operator.id,
        reviewedAt: new Date().toISOString(), decisionDigest: 'a'.repeat(64) },
        limits: { maxPendingPerPrincipal: 10, maxPendingPerWorkspace: 20, maxBackfillClaims: 0 },
        resources: async () => ticket.resources },
      placement: { claim: async () => {
        const current = candidate()
        const ready = current.profile.status === 'qualified' && current.profile.sourceCommit === commit
          && compatibleJobComputer(current, ticket.definition.spec)
        return { spec: ready ? current.spec : null, compatibleTargetCount: 1, reasons: ready ? [] : ['dependencies_changed'],
          diagnosticCodes: [], waitingHosts: [], selectedHost: ready ? 'computer' : null, exceedsMaximum: false }
      } } as never,
      prepareRuntime: blocked => preparation.ciRuntime.prepareForTicket(blocked),
      prepare: async () => ({ ...candidate().spec, source: { ...ticket.definition.spec.source,
        materializationId: ticket.id, materializationDigest: 'a'.repeat(64) } }),
      admit: async (_sql, _principal, definition, prepared, original) => {
        admitted(prepared)
        const runtime = verificationRuntimeFixture()
        return JobExecutionRecordSchema.parse({ ...jobExecution(), schemaVersion: 2,
          id: original.executionId, attemptId: original.attemptId, operationId: original.operationId,
          workspaceId: definition.workspaceId, acceptedSpec: { ...runtime.spec, ...prepared,
            definitionId: definition.id, definitionRevision: definition.revision, definitionVersionId: definition.versionId,
            profile: candidate().profile.measurement!.identity } })
      },
      wake: async () => {},
    }, () => new Date())
    try {
      expect(ticket.id).toBe(queued.ticket.id)
      expect(ticket.waitingReasons).toEqual([])
      expect(preparation.calls.prepare).toEqual([])
      await queue.waitForWork(await queue.scan())
      expect(ticket).toMatchObject({ state: 'blocked', waitingReasons: ['dependencies_changed'] })
      const prepared = await preparation.settle('p-unit')
      expect(prepared, prepared.message ?? '').toMatchObject({ state: 'qualified', commit, message: null })
      await queue.waitForWork(await queue.scan())
      expect(ticket).toMatchObject({ state: 'accepted', id: original.id, executionId: original.executionId,
        attemptId: original.attemptId, operationId: original.operationId, definition: original.definition })
      expect(ticket.definition.spec.policy.imageDigest).toBe(oldImage)
      expect(admitted).toHaveBeenCalledWith(expect.objectContaining({ policy: expect.objectContaining({ imageDigest: newImage }) }))
      expect(preparation.calls.publish).toEqual([{ repository: 'octo/site', commit }])
      expect(preparation.calls.prepare).toEqual([expect.objectContaining({ repository: preparation.clone, commit })])
      expect(preparation.calls.refresh).toHaveLength(1)
    } finally {
      await preparation.ciRuntime.close()
      await preparation.app.close()
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
