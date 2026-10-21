import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema, CI_HOST_NAMESPACE } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { useCiRuntimePreparationFixture } from './ci-runtime-preparation.test-support.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { CiPreparationRecordSchema, PostgresCiPreparationRepository } from '../src/modules/jobs/ciPreparationRepository.js'
import { commit, builder, mainId } from './helpers/ciPreparationFixture.js'

describe.skipIf(!postgresEnabled)('persisted runtime preparation access over authenticated MCP', () => {
  const { setup } = useCiRuntimePreparationFixture()

  it('rejects legacy preparation on a Host CI computer before creating an operation', async () => {
    const f = await setup()
    f.fixture.endpoint.capabilities = () => [{ namespace: CI_HOST_NAMESPACE, mainCanRequest: true }]
    const input = { workspaceId: f.fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
    expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
    const result = await f.call('build_computer_prepare', input)
    expect(result.isError).toBe(true)
    await expect(f.service.start(f.writer.principal, 'mcp', { ...input, commandId: randomUUID() }))
      .rejects.toMatchObject({ code: 'CI_RUNTIME_RETIRED' })
    await f.service.prepareForCommit(f.writer.principal, f.fixture.workspaceId, 'unit', commit)
    expect(f.fixture.calls.prepare).toEqual([])
    expect(f.fixture.calls.refresh).toEqual([])
    expect((await f.database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([])
    const read = await f.call('build_computer_prepare_get', {
      workspaceId: f.fixture.workspaceId, profileId: 'p-unit',
    }, f.reader.token)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read))).toMatchObject({ state: 'idle' })
  })

  it('settles an existing legacy preparation after its computer switches to Host CI without resuming setup', async () => {
    const f = await setup()
    f.fixture.endpoint.capabilities = () => [{ namespace: CI_HOST_NAMESPACE, mainCanRequest: true }]
    const repository = new PostgresCiPreparationRepository(f.database.pool)
    const now = new Date().toISOString()
    const record = CiPreparationRecordSchema.parse({ id: randomUUID(), source: 'mcp', principal: f.writer.principal,
      input: { workspaceId: f.fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() },
      profile: f.fixture.profiles.get('p-unit'), status: { profileId: 'p-unit', deviceId: builder,
        state: 'approving', commit, stage: null, message: null, profiles: [], startedAt: now, updatedAt: now } })
    await repository.create(f.database.pool, record)
    await f.service.recover()
    expect(await f.settle(f.service)).toMatchObject({ state: 'failed',
      message: 'This computer uses Host CI. Start a Host CI run with ci_run; legacy runtime preparation is unavailable.' })
    expect(await repository.pending()).toEqual([])
    await f.service.recover()
    expect(f.fixture.calls.prepare).toEqual([])
    expect(f.fixture.calls.refresh).toEqual([])
    expect(f.fixture.calls.publish).toEqual([])
    const persisted = await f.call('build_computer_prepare_get', {
      workspaceId: f.fixture.workspaceId, profileId: 'p-unit',
    }, f.reader.token)
    expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(persisted)).state).toBe('failed')
  })

  it('discovers scoped runtime refresh without advertising write access to a reader', async () => {
    const f = await setup()
    const { fixture } = f
    const writerTools = (await f.listTools()).tools
    const readerTools = (await f.listTools(f.reader.token)).tools
    for (const tools of [writerTools, readerTools]) {
      const profiles = tools.find(tool => tool.name === 'job_runtime_profile_list')!
      expect(profiles.description).toContain('Authorized writers can use build_computer_prepare')
      expect(profiles.description).toContain('arbitrary installer paths are unavailable')
    }
    expect(writerTools.some(tool => tool.name === 'build_computer_prepare')).toBe(true)
    expect(readerTools.some(tool => tool.name === 'build_computer_prepare')).toBe(false)
    expect((await f.call('build_computer_prepare', { workspaceId: fixture.workspaceId,
      profileId: 'p-unit', commit, commandId: randomUUID() }, f.reader.token)).isError).toBe(true)
    expect(decodeMcpToolResult((await f.call('build_computer_prepare_get', {
      workspaceId: fixture.workspaceId, profileId: 'p-unit',
    }, f.reader.token)))).toMatchObject({ state: 'idle' })
    expect(fixture.calls.prepare).toEqual([])
  })

  it.each(['missing', 'revoked', 'registration changed', 'wrong Main'] as const)(
    'rejects a new preparation for a computer whose identity is %s through MCP', async condition => {
      const f = await setup()
      const { database, fixture } = f
      const input = { workspaceId: fixture.workspaceId, profileId: 'p-unit', commit, commandId: randomUUID() }
      const devices = new PostgresDeviceAccessService(database.pool, mainId)
      if (condition === 'revoked') {
        await devices.revoke(f.writer.principal, builder, 1, randomUUID(), 'mcp')
      } else if (condition === 'missing') {
        await database.pool.query('delete from device_registrations where id=$1', [builder])
      } else if (condition === 'registration changed') {
        await database.pool.query(`update device_registrations
          set record=jsonb_set(record,'{authorizationRevision}','2'::jsonb) where id=$1`, [builder])
      } else {
        await database.pool.query('update application_installation set id=$1 where singleton=true', [randomUUID()])
      }
      expect((await f.call('build_computer_prepare', input, f.reader.token)).isError).toBe(true)
      const result = await f.call('build_computer_prepare', input)
      expect(result.isError).toBe(true)
      expect(fixture.calls.prepare).toEqual([])
      expect((await database.pool.query('select id from ci_runtime_preparations')).rows).toEqual([])
      expect((await database.pool.query(`select command_id from management_command_receipts
        where principal_id=$1 and operation='build_computer_prepare'`, [f.writer.principal.id])).rows).toEqual([])
      const read = await f.call('build_computer_prepare_get', {
        workspaceId: fixture.workspaceId, profileId: 'p-unit',
      }, f.reader.token)
      expect(BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(read)).state).toBe('idle')
    })


})
