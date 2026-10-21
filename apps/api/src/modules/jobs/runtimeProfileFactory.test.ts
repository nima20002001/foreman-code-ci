import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresSourceService } from '../sources/service.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { createJobRuntimeProfileService } from './runtimeProfileFactory.js'

it.each(['ready', 'unavailable', 'changed','root-revoked'] as const)('reads the complete %s verification profile status', async state => {
  const profile = verificationCapacityFixture('main')
  const saved = structuredClone(profile)
  const principal: ManagementPrincipal = { id: 'profile-reader', name: 'Reader', audience: 'operator',
    revokedAt: null, expiresAt: '2099-01-01T00:00:00.000Z',
    grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [profile.workspaceId] } }] }
  const query = vi.fn(async (text: string) => {
    if (text.includes('from management_principals')) return { rows: [{ ...principal,
      expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
    if (text.includes('from job_runtime_profiles')) return { rows: [{ record: profile }] }
    if (text.includes('from workspace_root_policies')) return { rows:state === 'root-revoked' ? [] : [{ allowed:true }] }
    return { rows: [] }
  })
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  const nativeWork = vi.fn(async () => { throw new Error('Readback attempted native work') })
  const fingerprint = profile.measurement!.fingerprint
  const metadata = state === 'unavailable' ? null : fingerprint
  const current = state === 'changed' ? { ...fingerprint, runtimeBinarySha256: 'b'.repeat(64) } : metadata
  const service = createJobRuntimeProfileService({ pool, commands: {} as PostgresCommandCoordinator,
    sources: {} as PostgresSourceService, host: {
      capture: nativeWork, descriptor: nativeWork, reserveQualification: nativeWork,
      currentConnection: async () => null, currentMetadata: async () => current,
    } })
  let reasons: string[] = ['context_changed']
  if (state === 'ready') reasons = []
  if (state === 'root-revoked') reasons = ['root_context_changed']
  expect(await service.list(principal, profile.workspaceId)).toEqual({ approvals: [], profiles: [{
    profile: saved, ready: state === 'ready', reasons,
    sideEffects: false,
  }] })
  expect(profile).toEqual(saved)
  expect(nativeWork).not.toHaveBeenCalled()
})
