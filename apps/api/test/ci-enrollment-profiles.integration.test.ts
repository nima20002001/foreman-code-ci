import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CiEnrollmentRepository } from '../src/modules/jobs/ciEnrollmentRepository.js'
import { DomainError } from '../src/modules/errors.js'
import { buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ciEnrollmentFixture } from './ci-enrollment.test-support.js'

describe.skipIf(!postgresEnabled)('automatic CI enrollment: profiles', () => {
  const fixture = ciEnrollmentFixture()

  it('enrolls Workers and Main with the same template envelope despite different storage and no repeated derivation', async () => {
    const f = await fixture()
    try {
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(state.computers).toHaveLength(3)
      expect(state.computers.every(computer => computer.state === 'preparing')).toBe(true)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      const saved = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles.map(row => row.profile)
      expect(saved).toHaveLength(3)
      for (const computer of state.computers) {
        expect(computer.profileIds).toHaveLength(1)
        const profile = saved.find(row => row.id === computer.profileIds[0])!
        expect(profile.schemaVersion).toBe(2)
        if (profile.schemaVersion !== 2) throw new Error('Verification profile required')
        if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
        expect(profile.spec.resources).toEqual(f.stored.spec.resources)
        expect(profile.spec.suites).toEqual(['unit'])
        const storage = await f.inventory.storage(computer.target)
        expect(profile.spec.resources.limits.diskBytes).toBeLessThanOrEqual(storage!.diskBytes)
        expect(profile.spec.resources.mutableInodes).toBeLessThanOrEqual(storage!.mutableInodes)
        expect(profile.root.selection.hostRef).toEqual(computer.target.hostRef)
      }
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles.map(row => row.profile)).toEqual(saved)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      const persisted = (await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
        [f.workspaceId])).rows.map(row => row.state)
      const readback = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(persisted).toEqual(expect.arrayContaining(readback.computers))
    } finally { await f.close() }
  })

  it('repairs a previously shrunk same-computer clone without losing its link or rewriting its saved version', async () => {
    const f = await fixture()
    try {
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const resources = f.stored.spec.resources
      const smaller = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: f.stored.name,
        spec: { ...f.stored.spec, resources: { ...resources,
          limits: { ...resources.limits, diskBytes: resources.limits.diskBytes / 2 } } },
      })
      await new CiEnrollmentRepository(f.db.pool).save(f.db.pool, f.workspaceId, {
        state: { target: f.computers[0]!.target, revision: 0, enabled: true, state: 'pending',
          profileIds: [smaller.id], templates: [], message: null, updatedAt: null },
        profiles: { [f.stored.id]: { profileId: smaller.id, digest: 'previous-template-budget' } },
      })
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(state.computers[0]!.profileIds).toEqual([smaller.id])
      const profiles = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      expect(profiles).toHaveLength(4)
      const repaired = profiles.find(row => row.profile.id === smaller.id)!.profile
      expect(repaired).toMatchObject({ revision: smaller.revision + 1, spec: { resources } })
      expect((await f.db.pool.query('select record from job_runtime_profile_versions where profile_id=$1 and revision=$2',
        [smaller.id, smaller.revision])).rows[0]!.record).toEqual(smaller)
      expect(profiles.find(row => row.profile.id === f.stored.id)!.profile).toEqual(f.stored)
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toEqual(profiles)
      expect((await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })).computers[0]!.profileIds)
        .toEqual([smaller.id])
    } finally { await f.close() }
  })

  it('reports required runtime/root setup and does not revive revoked profiles', async () => {
    const f = await fixture()
    try {
      const storage = f.inventory.storage
      const root = f.inventory.root
      f.inventory.storage = async target => target.hostRef.kind === 'main' ? null : storage(target)
      f.inventory.root = async (_principal, _workspace, _template, target) => {
        if (buildComputerKey(target) === buildComputerKey(f.computers[1]!.target)) {
          throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED', 'Approved writable root required.', 409)
        }
        return f.roots[0]!
      }
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(state.computers[1]).toMatchObject({ state: 'root-required',
        templates: [{ templateId: f.stored.id, profileId: null, state: 'root-required',
          message: 'Approved writable root required.' }] })
      expect(state.computers[2]!.state).toBe('runtime-required')
      f.inventory.storage = storage
      f.inventory.root = async (...args) => {
        if (buildComputerKey(args[3]) === buildComputerKey(f.computers[1]!.target)) {
          throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED', 'Approved writable root required.', 409)
        }
        return root(...args)
      }
      await f.enrollment.reconcile()
      const id = (await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId }))
        .computers[2]!.profileIds[0]!
      await f.db.pool.query(`update job_runtime_profiles set record=jsonb_set(record,'{status}','"revoked"') where id=$1`, [id])
      await f.enrollment.reconcile()
      expect((await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })).computers[2])
        .toMatchObject({ state: 'failed', profileIds: [], templates: [{ templateId: f.stored.id,
          profileId: null, state: 'failed', message: 'The enrolled CI profile was revoked.' }] })
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toHaveLength(2)
      expect(f.preparation.start).toHaveBeenCalledTimes(2)
    } finally { await f.close() }
  })

  it('stops automatic preparation when the enrollment owner is revoked', async () => {
    const f = await fixture()
    try {
      await f.enrollment.reconcile()
      f.preparations.clear()
      f.preparation.start.mockClear()
      await f.access.revoke(f.owner.principal.id)
      await f.enrollment.reconcile()
      expect(f.preparation.start).not.toHaveBeenCalled()
      await expect(f.enrollment.update(f.owner.principal, 'mcp', { workspaceId: f.workspaceId,
        target: f.computers[0]!.target, commandId: randomUUID(), expectedRevision: 0, enabled: false }))
        .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally { await f.close() }
  })
})
