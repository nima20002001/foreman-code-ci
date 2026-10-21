import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { useCiRuntimePreparationFixture } from './ci-runtime-preparation.test-support.js'
import pg from 'pg'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CiRuntimeProvisioner } from '../src/modules/jobs/ciRuntimeProvisioner.js'
import { commit, qualifiedPreparationProfile } from './helpers/ciPreparationFixture.js'

describe.skipIf(!postgresEnabled)('persisted runtime preparation coordination over authenticated MCP', () => {
  const { setup } = useCiRuntimePreparationFixture()

  it('serializes independent Main services and workspaces on the same computer at the same commit', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const f = await setup({ pause: stage => stage === 'source' ? paused : Promise.resolve() })
    const { fixture } = f
    const other = f.create()
    const foreign = structuredClone(fixture.profiles.get('p-unit')!)
    foreign.id = 'p-other'
    foreign.workspaceId = 'another-workspace'
    foreign.root.binding.workspaceId = 'another-workspace'
    fixture.profiles.set(foreign.id, qualifiedPreparationProfile(foreign))
    try {
      await f.service.start(f.writer.principal, 'mcp', { workspaceId: fixture.workspaceId,
        profileId: 'p-unit', commit, commandId: 'workspace-first' })
      await expect(other.start(f.writer.principal, 'mcp', { workspaceId: 'another-workspace',
        profileId: 'p-other', commit, commandId: 'workspace-second' })).rejects.toMatchObject({ code: 'CI_RUNTIME_BUSY' })
      await other.recover()
      release()
      expect((await f.settle(f.service)).state).toBe('qualified')
      expect(fixture.calls.prepare).toHaveLength(1)
      expect(fixture.calls.refresh).toHaveLength(1)
    } finally { release() }
  })

  it('starts preparation when profile reads share a single-connection application pool', async () => {
    const f = await setup()
    const { database, fixture } = f
    const pool = new pg.Pool({ ...database.pool.options, max: 1, connectionTimeoutMillis: 1000 })
    const commands = new PostgresCommandCoordinator(pool)
    const profiles = {
      ...fixture.profileService,
      list: async (...args: Parameters<typeof fixture.profileService.list>) => {
        await pool.query('select 1')
        return fixture.profileService.list(...args)
      },
    }
    const service = new CiRuntimeProvisioner(pool, profiles as never, fixture.sources as never,
      () => fixture.endpoint, commands, { timing: { pollMs: 0,
        wait: () => new Promise(resolve => setImmediate(resolve)), now: () => new Date() } })
    try {
      const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: 'single-connection' }
      expect(await service.start(f.writer.principal, 'mcp', input)).toMatchObject({ state: 'approving', commit })
      const done = await f.settle(service)
      expect(done.state).toBe('qualified')
      expect(await service.start(f.writer.principal, 'mcp', input)).toEqual(done)
      expect(fixture.calls.prepare).toHaveLength(1)
    } finally {
      await service.close()
      await pool.end()
    }
  })

  it('persists preparation failure over authenticated MCP and replays it after service replacement without refresh', async () => {
    const f = await setup({ prepareFails: true })
    const { database, fixture } = f
    const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
    const denied = await f.call('build_computer_prepare', input, f.reader.token)
    expect(denied.isError).toBe(true)
    expect((await database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([])
    expect((await database.pool.query(
      'select outcome from management_audit where principal_id=$1 and action=$2',
      [f.reader.principal.id, 'build_computer_prepare'],
    )).rows).toEqual([{ outcome: 'denied' }])
    expect((await f.call('build_computer_prepare', input)).isError).not.toBe(true)
    const failed = await f.settle(f.service)
    expect(failed).toMatchObject({ state: 'failed', message: 'podman build failed: no space left on device' })
    expect(fixture.calls.prepare).toHaveLength(1)
    expect(fixture.calls.refresh).toEqual([])
    expect(fixture.calls.qualified).toEqual([])
    const saved = (await database.pool.query('select id,active,record from ci_runtime_preparations')).rows[0]!
    expect(saved.active).toBe(false)
    expect(saved.record.status).toEqual(failed)
    await f.service.close()
    const replacement = f.create()
    f.services.ciRuntime = replacement
    await replacement.recover()
    const read = await f.call('build_computer_prepare_get', {
      workspaceId: fixture.workspaceId, profileId: 'p-unit',
    }, f.reader.token)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toEqual(failed)
    const replay = await f.call('build_computer_prepare', input)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(replay))).toEqual(failed)
    expect((await database.pool.query('select id,active from ci_runtime_preparations')).rows)
      .toEqual([{ id: saved.id, active: false }])
    expect(fixture.calls.prepare).toHaveLength(1)
    expect(fixture.calls.refresh).toEqual([])
  })
})
