import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ResolvedJobDefinitionSpecSchema } from '@foreman-code/contracts/jobs'
import { jobPolicyRequirementsRecord, type JobDefinitionRecord } from '@foreman-code/contracts/job-verification'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { JobComputerSelection } from '../src/modules/jobs/computerSelection.js'
import { JobService } from '../src/modules/jobs/service.js'
import { jobSpec } from './helpers/jobFixture.js'

function fixture() {
  const principal: ManagementPrincipal = { id: 'launch-writer', name: 'Launch writer', audience: 'operator',
    grants: [{ actions: ['jobs:start'], scope: { workspaceIds: ['workspace-fixture'] } }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const spec = ResolvedJobDefinitionSpecSchema.parse(jobSpec())
  const definition: JobDefinitionRecord = { schemaVersion: 1, id: 'job', workspaceId: 'workspace-fixture',
    name: 'Build', revision: 1, versionId: 'job-version', spec,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('select id,name,audience,grants') ? [{
    id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
    expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
  }] : [] }))
  const connect = vi.fn(async () => ({ query, release: vi.fn() }))
  const recordDenied = vi.fn()
  const validate = vi.fn(async () => ({ valid: true, reasons: [] as string[], sideEffects: false as const }))
  const validateRequest = vi.fn(async () => ({ valid: false, canQueue: true,
    reasons: ['offline'], sideEffects: false as const }))
  const limits = { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 32, diskBytes: 8388608 }
  const service = new JobService({ connect } as unknown as pg.Pool,
    { recordDenied } as unknown as PostgresCommandCoordinator, {
      preparation: { validate } as never, dispatch: {} as never, artifacts: {} as never,
      placement: { validateRequest } as unknown as JobComputerSelection,
      queue: { revision: 1, review: { reviewedByPrincipalId: principal.id,
        reviewedAt: definition.createdAt, decisionDigest: '1'.repeat(64) },
      limits: { maxPendingPerPrincipal: 20, maxPendingPerWorkspace: 40, maxBackfillClaims: 0 },
      resources: async () => ({ schemaVersion: 1, limits, mutableInodes: 100, controlTempBytes: 1024,
        scratchBytes: 1048576, scratchExecutable: false, shmBytes: 1024, spoolBytes: 4096, reportBytes: 4096 }) },
    })
  vi.spyOn(service.repository, 'definition').mockResolvedValue(definition)
  const input = { definitionId: definition.id, expectedRevision: definition.revision }
  return { principal, definition, spec, service, input, connect, recordDenied, validate, validateRequest, limits }
}

it('separates queue eligibility from temporary readiness and validates the effective computer request', async () => {
  const f = fixture()
  const target = { ...f.spec.target, mainInstallationId: 'other-installation' }
  const placementOverride = { kind: 'explicit' as const, target }
  expect(await f.service.validateLaunch(f.principal, f.definition.workspaceId, { ...f.input, placementOverride }, 'mcp'))
    .toEqual({ valid: false, canQueue: true, reasons: ['offline'], sideEffects: false })
  const spec = { ...f.spec, target: { kind: 'auto' },
    policy: jobPolicyRequirementsRecord(f.spec.policy), limits: f.limits }
  expect(f.validate).toHaveBeenCalledWith(expect.anything(), f.principal, f.definition.workspaceId, spec)
  expect(f.validateRequest).toHaveBeenCalledWith(expect.anything(), f.principal,
    f.definition.workspaceId, spec, placementOverride)
})

it('keeps invalid source configuration and stale saved revisions out of launch approval', async () => {
  const f = fixture()
  f.validate.mockResolvedValue({ valid: false, reasons: ['JOB_SOURCE_PIN_CONFLICT'], sideEffects: false })
  expect(await f.service.validateLaunch(f.principal, f.definition.workspaceId, f.input))
    .toMatchObject({ valid: false, canQueue: false, reasons: ['JOB_SOURCE_PIN_CONFLICT'] })
  expect(f.validateRequest).not.toHaveBeenCalled()
  await expect(f.service.validateLaunch(f.principal, f.definition.workspaceId, { ...f.input, expectedRevision: 2 }))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
})

it.each([
  { reason: 'offline', canQueue: true },
  { reason: 'authorization_revoked', canQueue: false },
])('rechecks queue authority for $reason when static runtime readiness fails', async ({ reason, canQueue }) => {
  const f = fixture()
  f.validate.mockResolvedValue({ valid: false, reasons: ['JOB_RUNTIME_UNQUALIFIED'], sideEffects: false })
  f.validateRequest.mockResolvedValue({ valid: false, canQueue, reasons: [reason], sideEffects: false })
  expect(await f.service.validateLaunch(f.principal, f.definition.workspaceId, f.input))
    .toMatchObject({ valid: false, canQueue, reasons: ['JOB_RUNTIME_UNQUALIFIED', reason] })
  expect(f.validateRequest).toHaveBeenCalledOnce()
})

it('denies a read-only caller and workspace escape before computer discovery', async () => {
  const f = fixture()
  const reader = { ...f.principal, grants: [{ actions: ['job_definitions:read' as const], scope: {} }] }
  await expect(f.service.validateLaunch(reader, f.definition.workspaceId, f.input, 'mcp'))
    .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  await expect(f.service.validateLaunch(f.principal, 'another-workspace', f.input, 'mcp'))
    .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(f.connect).not.toHaveBeenCalled()
  expect(f.validateRequest).not.toHaveBeenCalled()
  expect(f.recordDenied).toHaveBeenCalledTimes(2)
})
