import { workerToolServices } from './helpers/workerMcpServices.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as c from '@foreman-code/contracts/management'
import { AgentConfigurationVersionSchema, OperatorConfigurationVersionSchema, type HarnessConfiguration } from '@foreman-code/contracts'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { SkillCatalogService } from '../src/modules/skills/catalog.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { FoundationSettingsManagementService } from '../src/modules/settings/management.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import type { AppInteractionService } from '../src/modules/interactions/app.js'
import { createGraphqlMcpServer } from '../src/mcp/unified/server.js'
import { agentInstructionBundle } from '../src/modules/skills/instructions.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { deferred } from './helpers/deferred.js'

const qualify = { qualifyConfiguration: async (value: HarnessConfiguration) => {
  if (value.harness === 'claude') throw new Error('Skills library fixture supports only Codex qualification')
  return { harness: value.harness, version: 'fixture', authenticated: true,
  ready: true, structuredEvents: true, supportsResume: true, supportsCancellation: true, supportsWorkingDirectory: true,
  supportsStartupPrompt: true, supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }
} }
const codex = { harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' } as const

describe.skipIf(!postgresEnabled)('Skills library over real PostgreSQL, HTTP and the unified MCP', () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  let app: FastifyInstance
  let address: string
  let access: PostgresAccessService
  let commands: PostgresCommandCoordinator
  let services: OperatorServices
  let owner: string
  let workspaceA: string
  let workspaceB: string
  const clients: Client[] = []
  const directories: string[] = []

  async function http<T>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: T }> {
    const response = await fetch(new URL(path, address), { method, headers: { authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const json = await response.json() as { error?: unknown }
    // Errors arrive as { error: { code, message, details } }; tests read the error body directly.
    return { status: response.status, json: (response.ok ? json : json.error) as T }
  }
  async function mcp(token: string) {
    const client = new Client({ name: 'skills-test', version: '1.0.0' }); clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
    return client
  }
  async function issue(grants: c.ManagementPrincipal['grants'], audience: 'operator' = 'operator') {
    return (await access.issue({ name: `skills ${randomUUID()}`, audience, grants, expiresAt: new Date(Date.now() + 600_000) })).token
  }
  const versionCount = async (skillId: string) => Number((await database.pool.query<{ count: string }>(
    'select count(*) from workspace_skill_versions where skill_id=$1', [skillId])).rows[0]!.count)

  beforeAll(async () => {
    database = await currentDatabase()
    const runtime = await mkdtemp(join(tmpdir(), 'skills-runtime-')); directories.push(runtime)
    commands = new PostgresCommandCoordinator(database.pool)
    access = new PostgresAccessService(database.pool)
    const locations = new WorkspaceLocationService(database.pool, commands, runtime)
    const workspaces = new WorkspaceManagementService(database.pool, commands, locations)
    services = { commands, locations, workspaces,
      settings: new FoundationSettingsManagementService(new PostgresFoundationSettingsRepository(database.pool, runtime), commands, qualify, new PostgresOperatorRepository(database.pool)),
      extensions: {
      agents: new OperatorAgentMutationService(database.pool, commands, qualify), skills: new SkillCatalogService(database.pool, commands),
    } } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
    owner = await issue([{ actions: [...c.ManagementActionSchema.options], scope: {} }])
    const principal = (await access.authenticate(owner, ['operator']))
    workspaceA = (await workspaces.create(principal, 'http', { commandId: 'skills-ws-a', name: 'Skills A' })).value.workspace.id
    workspaceB = (await workspaces.create(principal, 'http', { commandId: 'skills-ws-b', name: 'Skills B' })).value.workspace.id
  }, 60_000)
  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app?.close()
    await database?.close()
    for (const directory of directories) await removeFixtureDirectory(directory)
  })

  it('backfills one head per existing skill without rewriting accepted versions', async () => {
    const record = (skillId: string, version: string, instructions: string, createdAt: string) => ({ workspaceId: workspaceA, skillId, version,
      name: `Legacy ${version}`, instructions, contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}`, createdAt })
    await database.pool.query("delete from application_migrations where version=267201")
    await database.pool.query('drop table workspace_skills; drop index workspace_skill_versions_sequence_idx; alter table workspace_skill_versions drop column sequence')
    const legacy = [record('legacy-guide', '2.0', 'Second', '2026-01-02T00:00:00.000Z'), record('legacy-guide', '1.0', 'First', '2026-01-01T00:00:00.000Z')]
    for (const item of legacy) await database.pool.query(`insert into workspace_skill_versions(workspace_id,skill_id,version,record,created_at) values($1,$2,$3,$4,$5)`,
      [workspaceA, item.skillId, item.version, JSON.stringify(item), item.createdAt])
    await applyApplicationMigrations(database.pool)
    const head = await http<import('zod').infer<typeof c.SkillGetResultSchema>>('GET', `/api/management/workspaces/${workspaceA}/skills/legacy-guide`, owner)
    expect(head.status).toBe(200)
    expect(head.json.skill).toMatchObject({ version: '2.0', revision: 2, versionCount: 2, name: 'Legacy 2.0', archived: false })
    expect(head.json.version.instructions).toBe('Second')
    const first = await http<import('zod').infer<typeof c.SkillGetResultSchema>>('GET', `/api/management/workspaces/${workspaceA}/skills/legacy-guide?version=1.0`, owner)
    expect(first.json.version).toEqual(legacy[1])
    // A user save allocates a server version after the historical labels.
    const saved = await http<c.SkillMutationResult>('PATCH', `/api/management/workspaces/${workspaceA}/skills/legacy-guide`, owner,
      { commandId: 'legacy-save-001', expectedRevision: 2, name: 'Legacy guide', instructions: 'Third' })
    expect(saved.json.value.version.version).toBe('3')
  })

  it('creates, lists, edits into immutable versions, replays receipts and rejects stale revisions over HTTP', async () => {
    const created = await http<c.SkillMutationResult>('POST', `/api/management/workspaces/${workspaceA}/skills`, owner,
      { commandId: 'create-reviewer-001', name: 'Reviewer ✓ 評価', description: 'Checks diffs', instructions: '# Review\n\n  Keep leading spaces.  \n' })
    expect(created.status).toBe(201)
    const skill = c.SkillMutationResultSchema.parse(created.json).value
    expect(skill).toMatchObject({ changed: true, skill: { version: '1', revision: 1, versionCount: 1 } })
    expect(skill.version.instructions).toBe('# Review\n\n  Keep leading spaces.  \n')
    const replay = await http<c.SkillMutationResult>('POST', `/api/management/workspaces/${workspaceA}/skills`, owner,
      { commandId: 'create-reviewer-001', name: 'Reviewer ✓ 評価', description: 'Checks diffs', instructions: '# Review\n\n  Keep leading spaces.  \n' })
    expect(replay.status).toBe(200)
    expect(replay.json).toMatchObject({ replayed: true, value: { skill: { skillId: skill.skill.skillId } } })
    const path = `/api/management/workspaces/${workspaceA}/skills/${skill.skill.skillId}`

    const list = c.SkillPageSchema.parse((await http('GET', `/api/management/skills?workspaceId=${workspaceA}&query=review`, owner)).json)
    expect(list.items.map((item) => item.skillId)).toEqual([skill.skill.skillId])
    expect(JSON.stringify(list)).not.toContain('Keep leading spaces')

    const unchanged = await http<c.SkillMutationResult>('PATCH', path, owner, { commandId: 'update-same-0001', expectedRevision: 1,
      name: 'Reviewer ✓ 評価', description: 'Checks diffs', instructions: '# Review\n\n  Keep leading spaces.  \n' })
    expect(unchanged.json.value).toMatchObject({ changed: false, skill: { revision: 1, version: '1' } })
    expect(await versionCount(skill.skill.skillId)).toBe(1)

    const edited = await http<c.SkillMutationResult>('PATCH', path, owner, { commandId: 'update-edit-0001', expectedRevision: 1,
      name: 'Reviewer', instructions: 'Version two' })
    expect(edited.json.value).toMatchObject({ changed: true, skill: { revision: 2, version: '2', versionCount: 2 } })
    expect(edited.json.value.skill.description).toBeUndefined()
    const stale = await http<{ code: string; details: { currentRevision: number } }>('PATCH', path, owner,
      { commandId: 'update-stale-001', expectedRevision: 1, name: 'Reviewer', instructions: 'Lost write' })
    expect(stale.status).toBe(409)
    expect(stale.json).toMatchObject({ code: 'SKILL_REVISION_CONFLICT' })
    const conflict = await http<{ code: string }>('PATCH', path, owner, { commandId: 'update-edit-0001', expectedRevision: 1, name: 'Changed', instructions: 'Other' })
    expect(conflict.json.code).toBe('COMMAND_ID_CONFLICT')

    const versions = c.SkillVersionPageSchema.parse((await http('GET', `${path}/versions`, owner)).json)
    expect(versions.items.map((item) => item.version)).toEqual(['2', '1'])
    const exact = c.SkillGetResultSchema.parse((await http('GET', `${path}?version=1`, owner)).json)
    expect(exact.version.instructions).toBe('# Review\n\n  Keep leading spaces.  \n')
    expect(exact.skill.version).toBe('2')

    const archived = await http<c.SkillMutationResult>('PUT', `${path}/archive`, owner, { commandId: 'archive-000001', expectedRevision: 2, archived: true })
    expect(archived.json.value.skill).toMatchObject({ archived: true, revision: 3 })
    const hidden = c.SkillPageSchema.parse((await http('GET', `/api/management/skills?workspaceId=${workspaceA}`, owner)).json)
    expect(hidden.items.some((item) => item.skillId === skill.skill.skillId)).toBe(false)
    const shown = c.SkillPageSchema.parse((await http('GET', `/api/management/skills?workspaceId=${workspaceA}&includeArchived=true`, owner)).json)
    expect(shown.items.find((item) => item.skillId === skill.skill.skillId)?.archived).toBe(true)
    const editArchived = await http<{ code: string }>('PATCH', path, owner, { commandId: 'update-archived1', expectedRevision: 3, name: 'X', instructions: 'Y' })
    expect(editArchived.json.code).toBe('SKILL_ARCHIVED')
    const audit = await database.pool.query<{ source: string }>(`select distinct source from management_audit where action like 'skill.%'`)
    expect(audit.rows.map((row) => row.source)).toEqual(['http'])
  })

  it.each(['create', 'update', 'archive'] as const)('rejects a skill %s after its publisher grant is revoked during admission',
    async (operation) => {
      const created = c.SkillMutationResultSchema.parse((await http('POST',
        `/api/management/workspaces/${workspaceB}/skills`, owner,
        { commandId: randomUUID(), name: 'Admission', instructions: 'Original instructions' })).json).value.skill
      const publisher = await access.issue({ name: 'Revoked publisher', audience: 'operator',
        grants: [{ actions: ['skills:read', 'skills:publish'], scope: { workspaceIds: [workspaceB] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const client = await mcp(publisher.token)
      const commandId = randomUUID()
      const entered = deferred()
      const released = deferred()
      const execute = commands.execute.bind(commands)
      const paused: typeof commands.execute = async (input) => {
        if (input.commandId === commandId && input.operation === `skill.${operation}`) {
          entered.resolve()
          await released.promise
        }
        return execute(input)
      }
      const spy = vi.spyOn(commands, 'execute').mockImplementation(paused)
      const before = await database.pool.query('select record from workspace_skill_versions where workspace_id=$1 order by skill_id,version',
        [workspaceB])
      const args: Record<string, unknown> = { workspaceId: workspaceB, commandId }
      if (operation === 'create') {
        args.name = 'Denied create'
        args.instructions = 'Denied instructions'
      } else {
        args.skillId = created.skillId
        args.expectedRevision = created.revision
        if (operation === 'archive') args.archived = true
        else {
          args.name = 'Denied update'
          args.instructions = 'Denied instructions'
        }
      }
      const pending = client.callTool({ name: `skill_${operation}`, arguments: args })
      try {
        await entered.promise
        await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
          [publisher.principal.id, JSON.stringify([{ actions: ['skills:read'], scope: { workspaceIds: [workspaceB] } }])])
        released.resolve()
        const denied = await pending
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
        const read = c.SkillGetResultSchema.parse(decodeMcpToolResult(await (await mcp(owner)).callTool({
          name: 'skill_get', arguments: { workspaceId: workspaceB, skillId: created.skillId },
        })))
        expect(read.skill).toEqual(created)
        expect(read.version.instructions).toBe('Original instructions')
        expect((await database.pool.query('select record from workspace_skill_versions where workspace_id=$1 order by skill_id,version',
          [workspaceB])).rows).toEqual(before.rows)
        expect((await database.pool.query('select count(*)::int as count from management_command_receipts where principal_id=$1 and command_id=$2',
          [publisher.principal.id, commandId])).rows[0].count).toBe(0)
      } finally {
        released.resolve()
        await pending
        spy.mockRestore()
      }
    })

  it('rejects a skill create when the principal is revoked while waiting for command admission', async () => {
    const publisher = await access.issue({ name: 'Revoked principal', audience: 'operator',
      grants: [{ actions: ['skills:publish'], scope: { workspaceIds: [workspaceB] } }],
      expiresAt: new Date(Date.now() + 600_000) })
    const client = await mcp(publisher.token)
    const commandId = randomUUID()
    const entered = deferred()
    const released = deferred()
    const execute = commands.execute.bind(commands)
    const paused: typeof commands.execute = async (input) => {
      if (input.commandId === commandId) {
        entered.resolve()
        await released.promise
      }
      return execute(input)
    }
    const spy = vi.spyOn(commands, 'execute').mockImplementation(paused)
    const pending = client.callTool({ name: 'skill_create', arguments: {
      workspaceId: workspaceB, commandId, name: 'Revoked create', instructions: 'Denied instructions',
    } })
    try {
      await entered.promise
      await access.revoke(publisher.principal.id)
      released.resolve()
      const denied = await pending
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('AUTH_REVOKED')
      const list = c.SkillPageSchema.parse(decodeMcpToolResult(await (await mcp(owner)).callTool({
        name: 'skill_list', arguments: { workspaceId: workspaceB, query: 'Revoked create' },
      })))
      expect(list.items).toEqual([])
      expect((await database.pool.query('select count(*)::int as count from management_command_receipts where principal_id=$1 and command_id=$2',
        [publisher.principal.id, commandId])).rows[0].count).toBe(0)
    } finally {
      released.resolve()
      await pending
      spy.mockRestore()
    }
  })

  it('serializes concurrent saves: one new version, one recoverable conflict', async () => {
    const created = c.SkillMutationResultSchema.parse((await http('POST', `/api/management/workspaces/${workspaceA}/skills`, owner,
      { commandId: 'create-race-0001', name: 'Race', instructions: 'Base' })).json).value.skill
    const path = `/api/management/workspaces/${workspaceA}/skills/${created.skillId}`
    const results = await Promise.all(['one', 'two'].map((name) => http<{ code?: string }>('PATCH', path, owner,
      { commandId: `race-${name}-00001`, expectedRevision: 1, name: 'Race', instructions: name })))
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    expect(await versionCount(created.skillId)).toBe(2)
  })

  it('offers equivalent management through the one MCP endpoint with per-caller permission errors and no side effects', async () => {
    const operator = await mcp(owner)
    const tools = (await operator.listTools()).tools.map((tool) => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['skill_list', 'skill_get', 'skill_versions_list', 'skill_create', 'skill_update', 'skill_archive']))
    const call = async (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
    const created = await call(operator, 'skill_create', { workspaceId: workspaceB, commandId: 'mcp-create-0001', name: 'MCP skill', instructions: 'From MCP' })
    expect(created.isError).not.toBe(true)
    const skill = c.SkillMutationResultSchema.parse(decodeMcpToolResult(created)).value.skill
    const updated = await call(operator, 'skill_update', { workspaceId: workspaceB, skillId: skill.skillId, commandId: 'mcp-update-0001',
      expectedRevision: 1, name: 'MCP skill', instructions: 'Edited by MCP' })
    expect(c.SkillMutationResultSchema.parse(decodeMcpToolResult(updated)).value.version.version).toBe('2')
    // Persisted readback through the browser HTTP surface.
    const read = c.SkillGetResultSchema.parse((await http('GET', `/api/management/workspaces/${workspaceB}/skills/${skill.skillId}`, owner)).json)
    expect(read.version.instructions).toBe('Edited by MCP')
    const sources = await database.pool.query<{ source: string }>(`select source from management_audit where action='skill.update' and target_key=$1`,
      [`workspace:${workspaceB}:skill:${skill.skillId}`])
    expect(sources.rows.map((row) => row.source)).toEqual(['mcp'])

    // Scoped to workspace A only: cannot read, list or write workspace B.
    const scoped = await mcp(await issue([{ actions: ['skills:read', 'skills:publish'], scope: { workspaceIds: [workspaceA] } }]))
    const list = c.SkillPageSchema.parse(decodeMcpToolResult((await call(scoped, 'skill_list', {}))))
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.every((item) => item.workspaceId === workspaceA)).toBe(true)
    for (const [name, args] of [
      ['skill_get', { workspaceId: workspaceB, skillId: skill.skillId }],
      ['skill_list', { workspaceId: workspaceB }],
      ['skill_update', { workspaceId: workspaceB, skillId: skill.skillId, commandId: 'mcp-denied-0001', expectedRevision: 2, name: 'Hijack', instructions: 'No' }],
      ['skill_archive', { workspaceId: workspaceB, skillId: skill.skillId, commandId: 'mcp-denied-0002', expectedRevision: 2, archived: true }],
    ] as const) {
      const denied = await call(scoped, name, args)
      expect(denied.isError, name).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    }
    // Publish permission alone must not reveal the existing body through archive/restore.
    const publisherToken = await issue([{ actions: ['skills:publish'], scope: { workspaceIds: [workspaceB] } }])
    const publisher = await mcp(publisherToken)
    for (const archived of [true, false]) {
      const input = { skillId: skill.skillId, expectedRevision: 2, archived }
      const deniedHttp = await http('PUT', `/api/management/workspaces/${workspaceB}/skills/${skill.skillId}/archive`, publisherToken,
        { ...input, commandId: `publish-only-http-${archived}` })
      expect(deniedHttp.status).toBe(403)
      expect(JSON.stringify(deniedHttp.json)).not.toContain('Edited by MCP')
      const deniedMcp = await call(publisher, 'skill_archive', { ...input, workspaceId: workspaceB, commandId: `publish-only-mcp-${archived}` })
      expect(deniedMcp.isError).toBe(true)
      expect(JSON.stringify(deniedMcp.content)).toContain('ACCESS_DENIED')
      expect(JSON.stringify(deniedMcp)).not.toContain('Edited by MCP')
    }
    // Read-only callers cannot create.
    const reader = await mcp(await issue([{ actions: ['skills:read'], scope: {} }]))
    const readerCreate = await call(reader, 'skill_create', { workspaceId: workspaceB, commandId: 'mcp-denied-0003', name: 'X', instructions: 'Y' })
    expect(readerCreate.isError).toBe(true)
    // A Worker Agent (Coder or Orchestrator role) on the one server is not offered skill management, and a
    // direct call is refused (the unified server lists only each role's own tools).
    for (const role of ['coder', 'orchestrator'] as const) {
      const server = await createGraphqlMcpServer({ references: workerToolServices(database.pool, commands).references, role, principal: { id: `worker-${role}`, name: role, audience: 'worker', agentId: 'agent-1',
        expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [{ actions: ['skills:read', 'skills:publish'], scope: {} }] },
      operator: services, interactions: { canRead: async () => true, canRespond: async () => role === 'orchestrator' } as unknown as AppInteractionService })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const worker = new Client({ name: role, version: '1' }); clients.push(worker)
      await worker.connect(clientTransport)
      expect((await worker.listTools()).tools.some((tool) => tool.name.startsWith('skill_'))).toBe(false)
      const refused = await worker.callTool({ name: 'skill_update', arguments: { workspaceId: workspaceB, skillId: skill.skillId,
        commandId: `mcp-denied-${role}`, expectedRevision: 2, name: 'W', instructions: 'W' } }).then((result) => result.isError === true, () => true)
      expect(refused).toBe(true)
    }
    // Nothing changed for any denied caller.
    const after = c.SkillGetResultSchema.parse((await http('GET', `/api/management/workspaces/${workspaceB}/skills/${skill.skillId}`, owner)).json)
    expect(after.skill).toMatchObject({ revision: 2, archived: false, name: 'MCP skill' })
    expect(await versionCount(skill.skillId)).toBe(2)
    // Revoked credentials are rejected at authentication.
    const revoked = await issue([{ actions: ['skills:read'], scope: {} }])
    const principal = await access.authenticate(revoked, ['operator'])
    await database.pool.query('update management_principals set revoked_at=now() where id=$1', [principal.id])
    expect((await http('GET', `/api/management/skills`, revoked)).status).toBe(401)
  })

  it('pins exact skill versions into Agent configurations and rejects forged, cross-workspace and archived references', async () => {
    const make = async (workspaceId: string, name: string, instructions: string) => c.SkillMutationResultSchema.parse((await http('POST',
      `/api/management/workspaces/${workspaceId}/skills`, owner, { commandId: `create-${randomUUID()}`, name, instructions })).json).value.skill
    const first = await make(workspaceA, 'First', 'Always answer in French.')
    const second = await make(workspaceA, 'Second', 'Sign with ~ok.')
    const foreign = await make(workspaceB, 'Foreign', 'Not yours.')
    const agents = `/api/management/workspaces/${workspaceA}/agents`
    const create = (agentId: string, assignedSkills: unknown, extra: Record<string, unknown> = {}) => http<{ code?: string; value: { metadataRevision: number } }>('POST', agents, owner,
      { commandId: `agent-${randomUUID()}`, agentId, name: agentId, productRole: 'coder', configuration: codex, prompt: { system: 'Be concise.' }, assignedSkills, ...extra })
    const agent = await create('skilled-agent', [{ skillId: second.skillId, version: '1' }, { skillId: first.skillId, version: '1' }])
    expect(agent.status).toBe(201)
    const row = await database.pool.query<{ record: unknown }>('select record from agent_configuration_versions where agent_id=$1', ['skilled-agent'])
    const configuration = AgentConfigurationVersionSchema.parse(row.rows[0]!.record)
    expect(configuration.instructionDelivery).toBe('native-v1')
    expect(configuration.resolvedSkills?.map((item) => [item.skillId, item.name, item.instructions])).toEqual([
      [second.skillId, 'Second', 'Sign with ~ok.'], [first.skillId, 'First', 'Always answer in French.']])

    // A later catalog edit does not change the pinned configuration.
    await http('PATCH', `/api/management/workspaces/${workspaceA}/skills/${first.skillId}`, owner,
      { commandId: `edit-${randomUUID()}`, expectedRevision: 1, name: 'First', instructions: 'Answer in German.' })
    const pinned = AgentConfigurationVersionSchema.parse((await database.pool.query<{ record: unknown }>(
      'select record from agent_configuration_versions where id=$1', [configuration.id])).rows[0]!.record)
    expect(pinned.resolvedSkills?.[1]?.instructions).toBe('Always answer in French.')

    expect((await create('forged-agent', [{ skillId: first.skillId, version: '1' }], {
      resolvedSkills: [{ skillId: first.skillId, version: '1', instructions: 'forged', contentHash: `sha256:${'0'.repeat(64)}` }] })).status).toBe(400)
    expect((await create('foreign-agent', [{ skillId: foreign.skillId, version: '1' }])).json.code).toBe('SKILL_VERSION_NOT_FOUND')
    expect((await create('duplicate-agent', [{ skillId: first.skillId, version: '1' }, { skillId: first.skillId, version: '2' }])).json.code).toBe('SKILL_DUPLICATE')
    expect((await create('missing-agent', [{ skillId: first.skillId, version: '99' }])).json.code).toBe('SKILL_VERSION_NOT_FOUND')
    await http('PUT', `/api/management/workspaces/${workspaceA}/skills/${second.skillId}/archive`, owner, { commandId: `arch-${randomUUID()}`, expectedRevision: 1, archived: true })
    expect((await create('archived-agent', [{ skillId: second.skillId, version: '1' }])).json.code).toBe('SKILL_ARCHIVED')
    // The Agent that already pinned the archived version keeps it through an unrelated edit.
    const kept = await http<unknown>('PATCH', `${agents}/skilled-agent`, owner, { commandId: `rename-${randomUUID()}`,
      expectedRevision: agent.json.value.metadataRevision, expectedConfigurationVersionId: configuration.id, name: 'Renamed' })
    expect(kept.status, JSON.stringify(kept.json)).toBe(200)
    expect(await database.pool.query('select count(*) from agents where id = any($1)', [['forged-agent', 'foreign-agent', 'duplicate-agent', 'missing-agent', 'archived-agent']]))
      .toMatchObject({ rows: [{ count: '0' }] })

    // MCP parity: an authorized Operator creates a skill and assigns it while building an Agent.
    const operator = await mcp(owner)
    const created = c.SkillMutationResultSchema.parse(decodeMcpToolResult((await operator.callTool({ name: 'skill_create', arguments: {
      workspaceId: workspaceA, commandId: 'mcp-assign-skill-1', name: 'Via MCP', instructions: 'Use MCP-created guidance.' } })))).value.skill
    const viaMcp = await operator.callTool({ name: 'agent_create', arguments: { workspaceId: workspaceA, commandId: 'mcp-assign-agent-1', agentId: 'mcp-agent',
      name: 'MCP Agent', productRole: 'coder', configuration: codex, assignedSkills: [{ skillId: created.skillId, version: created.version }] } })
    expect(viaMcp.isError, JSON.stringify(viaMcp.content)).not.toBe(true)
    const mcpConfig = AgentConfigurationVersionSchema.parse((await database.pool.query<{ record: unknown }>(
      'select record from agent_configuration_versions where agent_id=$1', ['mcp-agent'])).rows[0]!.record)
    expect(mcpConfig.resolvedSkills?.[0]).toMatchObject({ skillId: created.skillId, instructions: 'Use MCP-created guidance.' })
    // Destination authority without source (skills:read) authority cannot assign.
    const agentOnly = await mcp(await issue([{ actions: ['agents:create', 'agents:read'], scope: { workspaceIds: [workspaceA] } }]))
    const denied = await agentOnly.callTool({ name: 'agent_create', arguments: { workspaceId: workspaceA, commandId: 'mcp-assign-agent-2', agentId: 'denied-agent',
      name: 'Denied', productRole: 'coder', configuration: codex, assignedSkills: [{ skillId: created.skillId, version: created.version }] } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect((await database.pool.query('select 1 from agents where id=$1', ['denied-agent'])).rowCount).toBe(0)

    const huge = await make(workspaceA, 'Huge', 'x'.repeat(100_000))
    const many = [huge]
    for (let index = 0; index < 5; index++) many.push(await make(workspaceA, `Huge ${index}`, 'y'.repeat(100_000)))
    expect((await create('huge-agent', many.map((item) => ({ skillId: item.skillId, version: '1' })))).json.code).toBe('AGENT_INSTRUCTIONS_TOO_LARGE')
  })

  it('pins Operator skills from several workspaces through agent_defaults_update, with per-workspace source authority', async () => {
    const make = async (workspaceId: string, name: string) => c.SkillMutationResultSchema.parse((await http('POST',
      `/api/management/workspaces/${workspaceId}/skills`, owner, { commandId: `create-${randomUUID()}`, name, instructions: `${name} rules.` })).json).value.skill
    const a = await make(workspaceA, 'Operator A'), b = await make(workspaceB, 'Operator B')
    const operator = await mcp(owner)
    const read = async (client: Client) => c.ManagedAgentDefaultsSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'agent_defaults_get', arguments: {} }))))
    const defaults = await read(operator)
    const value = { ...defaults.value, operator: { ...defaults.value.operator,
      assignedSkills: [{ workspaceId: workspaceB, skillId: b.skillId, version: '1' }, { workspaceId: workspaceA, skillId: a.skillId, version: '1' }] } }
    // A caller that can update settings but only read skills in workspace A cannot pin a workspace B skill.
    const limited = await mcp(await issue([{ actions: ['settings:read', 'settings:update'], scope: {} }, { actions: ['skills:read'], scope: { workspaceIds: [workspaceA] } }]))
    const denied = await limited.callTool({ name: 'agent_defaults_update', arguments: { commandId: 'operator-skills-denied', expectedRevision: defaults.revision, value } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect((await read(operator)).value.operator.assignedSkills ?? []).toEqual([])
    const saved = await operator.callTool({ name: 'agent_defaults_update', arguments: { commandId: 'operator-skills-save1', expectedRevision: defaults.revision, value } })
    expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
    expect((await read(operator)).value.operator.assignedSkills).toEqual(value.operator.assignedSkills)
    const configuration = (await database.pool.query<{ record: { resolvedSkills: { name: string; instructions: string }[]; instructionDelivery: string } }>(
      `select c.record from application_operators o join operator_configuration_versions c on c.id=o.current_configuration_version_id`)).rows[0]!.record
    expect(configuration.instructionDelivery).toBe('native-v1')
    expect(configuration.resolvedSkills.map((item) => item.instructions)).toEqual(['Operator B rules.', 'Operator A rules.'])
    const before = await read(operator)
    const countBefore = (await database.pool.query('select count(*) from operator_configuration_versions')).rows[0].count
    const unchangedSkills = { ...before.value, operator: { ...before.value.operator, showThinking: !before.value.operator.showThinking } }
    const deniedRepublish = await limited.callTool({ name: 'agent_defaults_update', arguments: {
      commandId: 'operator-unchanged-skills-denied', expectedRevision: before.revision, value: unchangedSkills } })
    expect(deniedRepublish.isError).toBe(true)
    expect(JSON.stringify(deniedRepublish.content)).toContain('ACCESS_DENIED')
    const limitedToken = await issue([{ actions: ['settings:read', 'settings:update'], scope: {} }])
    expect((await http('PUT', '/api/management/settings/agents', limitedToken, {
      commandId: 'operator-unchanged-skills-http-denied', expectedRevision: before.revision, value: unchangedSkills })).status).toBe(403)
    expect(await read(operator)).toEqual(before)
    expect((await database.pool.query('select count(*) from operator_configuration_versions')).rows[0].count).toBe(countBefore)
    const republished = await operator.callTool({ name: 'agent_defaults_update', arguments: {
      commandId: 'operator-unchanged-skills-authorized', expectedRevision: before.revision, value: unchangedSkills } })
    expect(republished.isError).not.toBe(true)
    expect((await read(operator)).value.operator).toEqual(unchangedSkills.operator)
  })

  it('pins and delivers same-named historical skill IDs from distinct Operator workspaces', async () => {
    for (const [workspaceId, instructions] of [[workspaceA, 'Workspace A guidance.'], [workspaceB, 'Workspace B guidance.']] as const) {
      const record = { workspaceId, skillId: 'legacy-shared', version: '1', name: 'Shared historical ID', instructions,
        contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}`, createdAt: new Date().toISOString() }
      await database.pool.query(`insert into workspace_skill_versions(workspace_id,skill_id,version,sequence,record) values($1,$2,$3,1,$4)`,
        [workspaceId, record.skillId, record.version, JSON.stringify(record)])
      await database.pool.query(`insert into workspace_skills(workspace_id,skill_id,head_version,revision,version_count) values($1,$2,'1',1,1)`,
        [workspaceId, record.skillId])
    }
    const operator = await mcp(owner)
    const defaults = c.ManagedAgentDefaultsSchema.parse(decodeMcpToolResult((await operator.callTool({ name: 'agent_defaults_get', arguments: {} }))))
    const assignedSkills = [workspaceB, workspaceA].map((workspaceId) => ({ workspaceId, skillId: 'legacy-shared', version: '1' }))
    const saved = await operator.callTool({ name: 'agent_defaults_update', arguments: { commandId: 'operator-workspace-qualified',
      expectedRevision: defaults.revision, value: { ...defaults.value, operator: { ...defaults.value.operator, assignedSkills } } } })
    expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
    const record = (await database.pool.query(`select c.record from application_operators o join operator_configuration_versions c
      on c.id=o.current_configuration_version_id`)).rows[0].record
    const configuration = OperatorConfigurationVersionSchema.parse(record)
    expect(configuration.resolvedSkills?.map(({ workspaceId, skillId }) => ({ workspaceId, skillId })))
      .toEqual(assignedSkills.map(({ workspaceId, skillId }) => ({ workspaceId, skillId })))
    const text = agentInstructionBundle(configuration)!.text
    expect(text).toContain('Workspace B guidance.')
    expect(text).toContain('Workspace A guidance.')
    expect(text.indexOf('Workspace B')).toBeLessThan(text.indexOf('Workspace A'))
  })
})
