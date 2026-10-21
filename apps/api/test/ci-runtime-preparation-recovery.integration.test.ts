import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { useCiRuntimePreparationFixture } from './ci-runtime-preparation.test-support.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { ciPreparationLimits } from '../src/modules/jobs/ciPreparationLimits.js'
import { commit, builder, mainId } from './helpers/ciPreparationFixture.js'

describe.skipIf(!postgresEnabled)('persisted runtime preparation recovery over authenticated MCP', () => {
  const { setup } = useCiRuntimePreparationFixture()

  it('denies a reader, recovers a saved profile command after Main restarts and reads the completed command again', async () => {
    let reached!: () => void
    const atProfile = new Promise<void>(resolve => { reached = resolve })
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    let stopped = false
    const f = await setup({ loseRefreshAck: true, pause: async stage => {
      if (stage === 'profile' && !stopped) { reached(); await paused }
    } })
    const { database, fixture } = f
    const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
    try {
      const withoutDefinitionRead = await f.access.issue({
        name: 'Runtime author without definition reads', audience: 'operator',
        expiresAt: new Date(Date.now() + 3_600_000),
        grants: [{ actions: ManagementActionSchema.options.filter(action => action !== 'job_definitions:read'),
          scope: { workspaceIds: [fixture.workspaceId] } }],
      })
      const denied = await f.call('build_computer_prepare', input, withoutDefinitionRead.token)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
      expect((await database.pool.query(
        'select source,outcome from management_audit where principal_id=$1 and action=$2',
        [withoutDefinitionRead.principal.id, 'build_computer_prepare'],
      )).rows).toEqual([{ source: 'mcp', outcome: 'denied' }])
      expect((await database.pool.query(
        'select command_id from management_command_receipts where principal_id=$1',
        [withoutDefinitionRead.principal.id],
      )).rows).toEqual([])
      const unchanged = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      })
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(unchanged)).state).toBe('idle')
      expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
      expect(fixture.calls.prepare).toEqual([])
      expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
      await atProfile
      stopped = true
      const closing = f.service.close()
      release()
      await closing
      const recovered = f.create()
      f.services.ciRuntime = recovered
      expect((await recovered.get(f.writer.principal, { workspaceId: fixture.workspaceId, profileId: 'p-unit' })).state)
        .not.toBe('idle')
      await recovered.recover()
      const done = await f.settle(recovered)
      expect(done.state).toBe('qualified')
      expect(done.preparationLimits).toEqual(ciPreparationLimits())
      const retry = await f.call('build_computer_prepare', input)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(retry))).toEqual(done)
      const read = await f.call('build_computer_prepare_get', { workspaceId: fixture.workspaceId, profileId: 'p-unit' }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(done)
      expect(fixture.calls.refresh).toHaveLength(1)
      expect(fixture.calls.saves).toHaveLength(2)
    } finally { stopped = true; release() }
  })

  it.each(['continuation', 'recovery'] as const)(
    'retains failed preparation history when a device is revoked before %s', async phase => {
      let reached!: () => void
      const atSource = new Promise<void>(resolve => { reached = resolve })
      let release!: () => void
      const paused = new Promise<void>(resolve => { release = resolve })
      let stopped = false
      const f = await setup({ pause: async stage => {
        if (stage === 'source' && !stopped) {
          reached()
          await paused
        }
      } })
      const { database, fixture } = f
      const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
      try {
        expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
        expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
        await atSource
        const original = (await database.pool.query<{ id: string }>('select id from ci_runtime_preparations')).rows[0]!
        const devices = new PostgresDeviceAccessService(database.pool, mainId)
        await devices.revoke(f.writer.principal, builder, 1, randomUUID(), 'mcp')
        let service = f.service
        if (phase === 'recovery') {
          stopped = true
          const closing = service.close()
          release()
          await closing
          service = f.create()
          f.services.ciRuntime = service
          await service.recover()
        } else {
          release()
        }
        const done = await f.settle(service)
        expect(done).toMatchObject({ state: 'failed', message: 'Device access rejected: revoked' })
        expect(fixture.calls.prepare).toEqual([])
        expect(fixture.calls.refresh).toEqual([])
        expect(fixture.calls.qualified).toEqual([])
        expect((await database.pool.query('select id,device_id,active from ci_runtime_preparations')).rows)
          .toEqual([{ id: original.id, device_id: builder, active: false }])
        const read = await f.call('build_computer_prepare_get', {
          workspaceId: fixture.workspaceId, profileId: 'p-unit',
        }, f.reader.token)
        expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(done)
        expect((await f.call('build_computer_prepare', { ...input, commandId: randomUUID() })).isError).toBe(true)
        expect((await database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([original])
      } finally {
        stopped = true
        release()
      }
    })

  it('closes an active qualification and resumes the same persisted preparation through MCP', async () => {
    const f = await setup()
    const { database, fixture } = f
    const originalQualify = fixture.profileService.qualify
    let reached!: () => void
    const qualifying = new Promise<void>(resolve => { reached = resolve })
    let cancelProbe!: () => void
    fixture.profileService.qualify = async (principal, source, workspaceId, commandId, approvalId,
      options: { signal?: AbortSignal } = {}) => {
      reached()
      await new Promise<void>((_resolve, reject) => {
        cancelProbe = () => reject(new Error('Qualification interrupted'))
        options.signal?.throwIfAborted()
        options.signal?.addEventListener('abort', cancelProbe, { once: true })
      })
      return originalQualify(principal, source, workspaceId, commandId, approvalId)
    }
    const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
    let closing: Promise<void> | undefined
    let closed = false
    try {
      expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
      expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
      await qualifying
      closing = f.service.close().then(() => { closed = true })
      await vi.waitFor(() => { expect(closed).toBe(true) }, { timeout: 1_000 })
      expect(fixture.calls.qualified).toEqual([])
      const interrupted = (await database.pool.query('select id,active from ci_runtime_preparations')).rows[0]!
      expect(interrupted.active).toBe(true)
      const pending = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(pending)).state).toBe('qualifying')
      fixture.profileService.qualify = originalQualify
      const recovered = f.create()
      f.services.ciRuntime = recovered
      await recovered.recover()
      const done = await f.settle(recovered)
      expect(done.state).toBe('qualified')
      const read = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(done)
      expect((await database.pool.query('select id,active from ci_runtime_preparations')).rows)
        .toEqual([{ id: interrupted.id, active: false }])
      expect(fixture.calls.refresh).toHaveLength(1)
    } finally {
      fixture.profileService.qualify = originalQualify
      cancelProbe?.()
      await closing
    }
  })


})
