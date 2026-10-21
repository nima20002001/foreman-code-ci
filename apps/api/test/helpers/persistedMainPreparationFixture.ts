import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { BuildComputerPrepareStatusSchema, type CiRuntimeRequest } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { CiRuntimeProvisioner } from '../../src/modules/jobs/ciRuntimeProvisioner.js'
import { PostgresCiPreparationRepository } from '../../src/modules/jobs/ciPreparationRepository.js'
import { JobOwnership } from '../../src/modules/jobs/ownership.js'
import { buildComputerKey, buildComputerTarget } from '../../src/modules/settings/buildComputers.js'
import { registerJobRuntimeProfileRoutes } from '../../src/routes/jobRuntimeProfiles.js'
import { graphRpc } from '../eng04-graph-composition-fixture.js'
import { currentDatabase } from './eng04CurrentDatabase.js'
import { ciPreparationFixture, mainId } from './ciPreparationFixture.js'

export async function persistedMainPreparationFixture(database: Awaited<ReturnType<typeof currentDatabase>>,
  options: Parameters<typeof ciPreparationFixture>[0] & {
    onMainRefresh?(): Promise<void>
    acquire?: typeof JobOwnership.acquire
  } = {}) {
  const installationId = options.mainInstallationId ?? mainId
  const fixture = await ciPreparationFixture({ ...options, main: 'installed' })
  const runtimes: Array<{ service: CiRuntimeProvisioner; app: ReturnType<typeof buildApp> }> = []
  const close = async () => {
    for (const runtime of runtimes) {
      await runtime.service.close()
      await runtime.app.close()
    }
    await fixture.ciRuntime.close()
    await fixture.app.close()
  }
  try {
    await database.pool.query('update application_installation set id=$1 where singleton=true', [installationId])
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [fixture.workspaceId,
      JSON.stringify({ id: fixture.workspaceId, name: 'Main recovery',
        repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' } })])
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Main recovery writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000),
      grants: [{ actions: [...ManagementActionSchema.options], scope: { workspaceIds: [fixture.workspaceId] } }] })
    const reader = await access.issue({ name: 'Main recovery reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000),
      grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [fixture.workspaceId] } }] })
    const profile = fixture.profiles.get('p-main')!
    const target = buildComputerTarget({ hostRef: profile.root.selection.hostRef,
      registration: profile.root.registration, mainInstallationId: installationId })
    await database.pool.query(`insert into build_computer_preferences
      (host_key,target,revision,build_enabled,build_priority,updated_by) values($1,$2::jsonb,1,true,100,$3)`,
    [buildComputerKey(target), JSON.stringify(target), writer.principal.id])
    const commands = new PostgresCommandCoordinator(database.pool)
    const repository = new PostgresCiPreparationRepository(database.pool)
    let now = new Date()
    const create = async () => {
      const service = new CiRuntimeProvisioner(database.pool, fixture.profileService as never,
        fixture.sources as never, () => { throw new Error('Main preparation cannot use a paired Worker') }, commands,
        { ...(options.acquire ? { acquire: options.acquire } : {}),
          timing: { pollMs: 0, now: () => now, wait: () => new Promise(resolve => setImmediate(resolve)) },
          main: () => ({ handle: async (request: CiRuntimeRequest) => {
            const result = await fixture.main!()!.handle(request)
            if (request.operation === 'refresh') await options.onMainRefresh?.()
            return result
          } }) })
      const services = { commands, ciRuntime: service,
        jobRuntimeProfiles: fixture.profileService } as unknown as OperatorServices
      const app = buildApp({ readiness: { database: { ping: async () => { await database.pool.query('select 1') } },
        checkpoints: { ping: async () => undefined } }, operator: { access, services } })
      registerJobRuntimeProfileRoutes(app, fixture.profileService as never, service)
      runtimes.push({ service, app })
      const origin = await app.listen({ port: 0, host: '127.0.0.1' })
      const call = async (name: string, input: unknown, token = writer.token) => {
        const response = await graphRpc(app, token, 'tools/call', { name, arguments: input })
        if (!response.result) throw new Error(JSON.stringify(response.error))
        return response.result
      }
      const path = `/api/management/workspaces/${fixture.workspaceId}/jobs/runtime-profiles/p-main/computer-preparation`
      const read = async () => {
        const response = await call('build_computer_prepare_get', {
          workspaceId: fixture.workspaceId, profileId: 'p-main',
        }, reader.token)
        if (response.isError) throw new Error(JSON.stringify(response))
        return BuildComputerPrepareStatusSchema.parse(decodeMcpToolResult(response))
      }
      const httpRead = () => fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${reader.token}`, connection: 'close' },
      })
      const httpStart = (input: { commandId: string; commit?: string }, token = writer.token) =>
        fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
          'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(input) })
      return { service, app, call, read, httpRead, httpStart }
    }
    return { fixture, writer, reader, repository, commands, create,
      advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds) },
      close }
  } catch (error) {
    await close()
    throw error
  }
}
