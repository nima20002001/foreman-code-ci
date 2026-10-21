import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { CiEnrollmentStateSchema } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { ciEnrollmentFixture } from './ci-enrollment.test-support.js'

describe.skipIf(!postgresEnabled)('automatic CI enrollment: storage', () => {
  const fixture = ciEnrollmentFixture()

  it.each(['disk', 'inodes'] as const)('reports insufficient %s through MCP without shrinking a clone', async field => {
    const f = await fixture()
    try {
      const storage = f.inventory.storage
      const target = f.computers[1]!.target
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const resources = f.stored.spec.resources
      f.inventory.storage = async computer => {
        if (buildComputerKey(computer) !== buildComputerKey(target)) return storage(computer)
        return { diskBytes: resources.limits.diskBytes - (field === 'disk' ? 1 : 0),
          mutableInodes: resources.mutableInodes - (field === 'inodes' ? 1 : 0) }
      }
      await f.enrollment.reconcile()
      const client = await f.connect()
      const result = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(result))
      expect(state.computers[1]).toMatchObject({ target, state: 'storage-required', profileIds: [],
        templates: [{ templateId: f.stored.id, profileId: null, state: 'storage-required',
          message: 'The installed CI volume is too small for this template’s disk or inode budget.' }] })
      expect(state.computers[0]!.state).toBe('preparing')
      expect(state.computers[2]!.state).toBe('preparing')
      const profiles = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      expect(profiles).toHaveLength(2)
      for (const { profile } of profiles) {
        if (profile.schemaVersion !== 2) throw new Error('Verification profile required')
        expect(profile.spec.resources).toEqual(resources)
      }
      expect(f.preparation.start).toHaveBeenCalledTimes(2)
      expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1 and host_key=$2',
        [f.workspaceId, buildComputerKey(target)])).rows[0]!.state).toEqual(state.computers[1])
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toEqual(profiles)
      expect(f.preparation.start).toHaveBeenCalledTimes(2)
    } finally { await f.close() }
  })

  it('prepares a fitting template despite another template exceeding installed storage', async () => {
    const f = await fixture()
    try {
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const resources = f.stored.spec.resources
      const oversized = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: 'Large suite',
        spec: { ...f.stored.spec, resources: { ...resources,
          limits: { ...resources.limits, diskBytes: resources.limits.diskBytes * 2 } } },
      })
      f.inventory.storage = async () => ({ diskBytes: resources.limits.diskBytes, mutableInodes: resources.mutableInodes })
      await f.enrollment.reconcile()
      const client = await f.connect()
      const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
      for (const computer of state.computers) {
        expect(computer.state).toBe('partial')
        expect(computer.profileIds).toHaveLength(1)
        expect(computer.templates).toContainEqual(expect.objectContaining({ templateId: oversized.id,
          profileId: null, state: 'storage-required' }))
        expect(computer.templates).toContainEqual({ templateId: f.stored.id,
          profileId: computer.profileIds[0], state: 'preparing', message: null })
        expect(computer.message).toContain('Large suite:')
      }
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      const saved = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      expect(saved).toHaveLength(4)
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toEqual(saved)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
        [f.workspaceId])).rows.map(row => row.state.templates))
        .toEqual(expect.arrayContaining(state.computers.map(computer => computer.templates)))
    } finally { await f.close() }
  })

  it('continues preparation after one profile fails and persists the failed template through MCP', async () => {
    const f = await fixture()
    try {
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const failing = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: 'Failing suite', spec: f.stored.spec,
      })
      const start = f.preparation.start.getMockImplementation()!
      f.preparation.start.mockImplementation(async (...args) => {
        const profile = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
          .find(row => row.profile.id === args[2].profileId)!.profile
        if (profile.name === failing.name) {
          throw new DomainError('CI_RUNTIME_PREPARATION_FAILED', 'Runtime preparation failed.', 409)
        }
        return start(...args)
      })
      await f.enrollment.reconcile()
      const client = await f.connect()
      const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
      for (const computer of state.computers) {
        expect(computer.state).toBe('partial')
        const failure = computer.templates.find(result => result.templateId === failing.id)!
        expect(failure).toMatchObject({ state: 'failed', message: 'Runtime preparation failed.' })
        expect(failure.profileId).not.toBeNull()
        expect(computer.templates).toContainEqual(expect.objectContaining({ templateId: f.stored.id, state: 'preparing' }))
        expect(computer.message).toContain('Failing suite: Runtime preparation failed.')
      }
      expect(f.preparation.start).toHaveBeenCalledTimes(6)
      expect(f.preparations.size).toBe(3)
      expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
        [f.workspaceId])).rows.map(row => row.state)).toEqual(expect.arrayContaining(state.computers))
    } finally { await f.close() }
  })
})
