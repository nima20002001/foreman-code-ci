import Fastify from 'fastify'
import { afterEach, beforeEach } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CiRuntimeProvisioner } from '../src/modules/jobs/ciRuntimeProvisioner.js'
import { buildComputerTarget, buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import { ciPreparationFixture, builder, mainId } from './helpers/ciPreparationFixture.js'

export function useCiRuntimePreparationFixture() {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let fixture: Awaited<ReturnType<typeof ciPreparationFixture>>
  const provisioners: CiRuntimeProvisioner[] = []
  const apps: ReturnType<typeof Fastify>[] = []
  beforeEach(async () => { database = await agent3Database() }, 60_000)
  afterEach(async () => {
    await Promise.allSettled(provisioners.splice(0).map(service => service.close()))
    await Promise.allSettled(apps.splice(0).map(app => app.close()))
    await fixture?.ciRuntime.close()
    await fixture?.app.close()
    await database?.close()
  })

  async function setup(options: Parameters<typeof ciPreparationFixture>[0] = {}) {
    fixture = await ciPreparationFixture(options)
    await database.pool.query('update application_installation set id=$1 where singleton=true', [mainId])
    const access = new PostgresAccessService(database.pool)
    const writer = await access.issue({ name: 'Runtime author', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
    const reader = await access.issue({ name: 'Runtime reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions: ['job_definitions:read'], scope: {} }] })
    const commands = new PostgresCommandCoordinator(database.pool)
    for (const workspaceId of [fixture.workspaceId, 'another-workspace']) {
      await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
        JSON.stringify({ id: workspaceId, name: 'Runtime preparation',
          repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' } })])
    }
    await database.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$1,'synthetic-runtime-key',$3::jsonb)`, [builder, mainId, JSON.stringify({
      mainId, deviceId: builder, workerInstallationId: builder, publicKeyFingerprint: 'a'.repeat(64),
      keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] })])
    const profile = fixture.profiles.get('p-unit')!
    const target = buildComputerTarget({ hostRef: profile.root.selection.hostRef,
      registration: profile.root.registration, mainInstallationId: mainId })
    await database.pool.query(`insert into build_computer_preferences
      (host_key,target,revision,build_enabled,build_priority,updated_by) values($1,$2::jsonb,1,true,100,$3)`,
    [buildComputerKey(target), JSON.stringify(target), writer.principal.id])
    const create = () => {
      const service = new CiRuntimeProvisioner(database.pool, fixture.profileService as never, fixture.sources as never,
        () => fixture.endpoint, commands, { timing: { pollMs: 0,
          wait: () => new Promise(resolve => setImmediate(resolve)), now: () => new Date() } })
      provisioners.push(service)
      return service
    }
    const service = create()
    const app = Fastify()
    apps.push(app)
    const services = { commands, ciRuntime: service, jobRuntimeProfiles: fixture.profileService } as unknown as OperatorServices
    const interactions = { toolAccess: async () => ({ role: 'coder', tools: [] }), canRead: async () => false,
      canRespond: async () => false } as unknown as AppInteractionService
    registerGraphqlMcp(app, { access, operator: services, interactions })
    const url = await app.listen({ port: 0, host: '127.0.0.1' })
    const rpc = async (method: string, params: unknown, bearer = writer.token) => {
      const response = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream', connection: 'close' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const body = await response.text()
      return JSON.parse(body.split('\n').find(line => line.startsWith('data: '))?.slice(6) ?? body).result
    }
    const call = async (name: string, input: unknown, bearer = writer.token) =>
      await rpc('tools/call', { name, arguments: input }, bearer) as {
        isError?: boolean; structuredContent?: unknown
      }
    const listTools = async (bearer = writer.token) =>
      await rpc('tools/list', {}, bearer) as { tools: { name: string; description: string }[] }
    const settle = async (service: CiRuntimeProvisioner) => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const status = await service.get(writer.principal, { workspaceId: fixture.workspaceId, profileId: 'p-unit' })
        if (['qualified', 'failed'].includes(status.state)) return status
        await new Promise(resolve => setImmediate(resolve))
      }
      throw new Error('Preparation did not settle')
    }
    return { service, create, call, listTools, settle, writer, reader, services, access, database, fixture }
  }

  return { setup }
}
