import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line no-restricted-imports -- A short observation window proves the held launcher prevents completion.
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessMcpListResultSchema, HarnessMcpPlanSchema, HarnessMcpPlanResultSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { APP_MCP_TIMEOUTS, installManagedLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { registerWorkerMcpInstallation } from '../src/modules/harnesses/workerMcpInstallation.js'
import { withNativeMcpDelivery } from '../src/modules/harnesses/nativeMcpDelivery.js'
import { applyMcpEdits, fingerprint, mcpEdits, type NativeMcpAdapter, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { heldLauncher } from './helpers/launcherLock.js'

const connectionString = process.env.TEST_DATABASE_URL!
const clients: Client[] = []
afterEach(async () => { for (const client of clients.splice(0)) await client.close() })

it('requests exact Foreman Code and Linear presets through authenticated MCP, then applies and reads back both harnesses', async () => {
  const admin = new pg.Pool({ connectionString })
  const schema = `managed_mcp_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const endpoint = 'http://127.0.0.1:3000/mcp'
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'managed-mcp-cache-'))
  const file = join(directory, 'config.toml')
  await writeFile(file, '')
  const snapshots = Object.fromEntries((['codex'] as const).map((harness) => [harness,
    { harness, revision: fingerprint({}), effective: {}, user: {}, userConfig: {}, file, version: '1' }])) as Record<'codex', NativeMcpSnapshot>
  let reads = 0
  let inspectionFails = false
  let held: Awaited<ReturnType<typeof heldLauncher>> | undefined
  let installLauncher: (() => void) | undefined
  const adapter = (harness: 'codex'): NativeMcpAdapter => ({
    read: async () => {
      reads++
      if (inspectionFails) throw new Error('Native inspection unavailable')
      return structuredClone(snapshots[harness])
    },
    apply: async (snapshot, change, signal, managed) => {
      if (held && installLauncher) {
        await withNativeMcpDelivery(async writing => {
          installLauncher!()
          await installManagedLauncher(held!.source, held!.launcher, signal)
          signal.throwIfAborted()
          writing()
        })
      }
      const user = applyMcpEdits(snapshot.user, mcpEdits(snapshot, change, managed))
      await writeFile(file, JSON.stringify(user))
      snapshots[harness] = { ...snapshot, user, effective: structuredClone(user), revision: fingerprint(user),
        }
    },
  })
  const adapters = { codex: adapter('codex') }
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  const mcp = new HarnessMcpSettingsService(pool, commands, adapters, () => {}, async () => {}, endpoint)
  const services = { commands, harnessSettings: { mcp, directories: {} } } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  try {
    await applyApplicationMigrations(pool)
    const owner = await access.issue({ name: 'MCP owner', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 3600_000) })
    const delegated = await access.issue({ name: 'MCP requester', audience: 'operator', grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 3600_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [delegated.principal.id, owner.principal.id])
    const reader = await access.issue({ name: 'MCP reader', audience: 'operator', grants: [{ actions: ['harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 3600_000) })
    const writer = await access.issue({ name: 'MCP writer without read access', audience: 'operator',
      grants: [{ actions: ['harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 3600_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'managed-mcp-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(delegated.token)
    const denied = await connect(reader.token)
    const deniedReader = await connect(writer.token)
    expect((await denied.listTools()).tools.map((tool) => tool.name)).not.toContain('harness_mcp_managed_request')
    const deniedRequest = await denied.callTool({ name: 'harness_mcp_managed_request', arguments: {} })
    expect(deniedRequest.isError).toBe(true)
    expect(JSON.stringify(deniedRequest.content)).toContain('ACCESS_DENIED')
    const listed = async (harness: 'codex') => HarnessMcpListResultSchema.parse(
      decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_servers_list', arguments: { harness } }))))
    const genericInput = { harness: 'codex', commandId: randomUUID(), change: {
      kind: 'add', name: 'example', connection: { transport: 'remote', url: 'https://example.test/mcp' },
    } }
    const planHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/plans',
      headers: { authorization: `Bearer ${delegated.token}` }, payload: genericInput })
    expect(planHttp.statusCode).toBe(200)
    const genericPlan = HarnessMcpPlanResultSchema.parse(planHttp.json()).value
    const decisionHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/decision',
      headers: { authorization: `Bearer ${delegated.token}` }, payload: { planId: genericPlan.id, approve: true } })
    expect(decisionHttp.statusCode).toBe(200)
    expect(HarnessMcpPlanSchema.parse(decisionHttp.json()).status).toBe('applied')
    expect((await listed('codex')).servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'example', label: 'https://example.test', transport: 'remote',
        enabled: true, origin: 'user', editable: true }),
    ]))
    expect((await listed('codex')).servers.find((server) => server.name === 'example')?.endpoint).toBeUndefined()
    expect(JSON.parse(await readFile(file, 'utf8')).example.url).toBe('https://example.test/mcp')
    const reconcileInput = { planId: genericPlan.id, commandId: randomUUID() }
    const reconcileHttp = await app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/reconcile',
      headers: { authorization: `Bearer ${delegated.token}` }, payload: reconcileInput })
    expect(reconcileHttp.statusCode).toBe(200)
    expect(HarnessMcpPlanResultSchema.parse(reconcileHttp.json()).value.status).toBe('applied')
    for (const [route, payload] of [
      ['plans', genericInput], ['decision', { planId: genericPlan.id, approve: true }], ['reconcile', reconcileInput],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: `/api/management/harnesses/mcp/${route}`,
        headers: { authorization: `Bearer ${reader.token}` }, payload })
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('ACCESS_DENIED')
    }
    const genericRead = HarnessMcpPlanSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'harness_mcp_change_get', arguments: { planId: genericPlan.id },
    })))
    expect(genericRead.status).toBe('applied')
    const cleanup = await client.callTool({ name: 'harness_mcp_change_request', arguments: {
      harness: 'codex', commandId: randomUUID(), change: { kind: 'remove', name: 'example' },
    } })
    expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult(cleanup)).status).toBe('applied')
    for (const harness of ['codex'] as const) {
      for (const preset of ['graphql', 'linear'] as const) {
        const before = await listed(harness)
        const previousReads = reads
        expect(await listed(harness)).toEqual(before)
        expect(reads).toBe(previousReads)
        const deniedList = await deniedReader.callTool({ name: 'harness_mcp_servers_list', arguments: { harness } })
        expect(deniedList.isError).toBe(true)
        expect(JSON.stringify(deniedList.content)).toContain('ACCESS_DENIED')
        expect(reads).toBe(previousReads)
        expect(before.presets?.[preset]).toBe('missing')
        const args = { harness, preset, installed: true, expectedRevision: before.revision, commandId: randomUUID() }
        // The delegated Operator applies the preset itself: no human review step.
        const applied = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: args }))))
        expect(applied).toMatchObject({ status: 'applied', managedPreset: preset })
        expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: args }))))).toEqual(applied)
        await expect(client.callTool({ name: 'harness_mcp_change_request', arguments: { harness, expectedRevision: before.revision,
          commandId: randomUUID(), change: { kind: 'add', name: 'graphql', connection: { transport: 'remote', url: endpoint } } } })).resolves.toMatchObject({ isError: true })
        const bearerApplied = await app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/managed',
          headers: { authorization: `Bearer ${delegated.token}` }, payload: args })
        expect(bearerApplied.statusCode).toBe(200)
        expect(HarnessMcpPlanSchema.parse(bearerApplied.json())).toEqual(applied)
        const bearerDenied = await app.inject({ method: 'POST', url: '/api/management/harnesses/mcp/managed',
          headers: { authorization: `Bearer ${reader.token}` }, payload: { ...args, commandId: randomUUID() } })
        expect(bearerDenied.statusCode).toBe(403)
        expect(bearerDenied.json().error.code).toBe('ACCESS_DENIED')
        expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_change_get', arguments: { planId: applied.id } })))).status).toBe('applied')
        const installedList = await listed(harness)
        expect(installedList.presets?.[preset]).toBe('installed')
        expect(installedList.servers.find((server) => server.name === (preset === 'graphql' ? 'foreman-code' : preset))?.endpoint)
          .toBe(preset !== 'linear' ? undefined : 'https://mcp.linear.app/mcp/readonly')
        if (preset === 'graphql') expect(installedList.servers.find((server) => server.name === 'foreman-code')?.transport).toBe('stdio')
        if (preset === 'graphql') expect(JSON.stringify((await listed(harness)).servers)).not.toContain('GRAPHQL_MCP_TOKEN')
        const name = preset === 'graphql' ? 'foreman-code' : preset
        const original = structuredClone(snapshots[harness].user[name])
        if (preset === 'graphql') {
          expect(original).toMatchObject({ startup_timeout_sec: 60, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec })
          expect(JSON.parse(await readFile(file, 'utf8'))[name]).toEqual(original)
        }
        for (const enabled of [false, true]) {
          const toggle = { harness, preset, enabled, commandId: randomUUID() }
          const togglePlan = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: toggle }))))
          expect(togglePlan.change).toEqual({ kind: 'enable', name, enabled })
          expect(togglePlan.status).toBe('applied')
          const toggled = await listed(harness)
          expect(toggled.presets?.[preset]).toBe(enabled ? 'installed' : 'disabled')
          expect(toggled.servers.find((server) => server.name === name)?.enabled).toBe(enabled)
          expect(snapshots[harness].user[name]).toEqual({ ...original as object, enabled })
        }
        const removal = { harness, preset, installed: false, expectedRevision: (await listed(harness)).revision, commandId: randomUUID() }
        const removePlan = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: removal }))))
        expect(removePlan).toMatchObject({ status: 'applied', change: { kind: 'remove' } })
        expect((await listed(harness)).presets?.[preset]).toBe('missing')
      }
      // Retired per-role entries are replaced by the one graphql entry in the same reviewed write.
      const legacy = { 'graphql-app': { enabled: true }, 'graphql-operator': { enabled: true } }
      snapshots[harness] = { ...snapshots[harness], user: legacy, effective: structuredClone(legacy), revision: fingerprint(legacy) }
      await writeFile(file, JSON.stringify(legacy))
      const before = await listed(harness)
      expect(before.presets?.graphql).toBe('legacy')
      expect(before.servers.find((server) => server.name === 'graphql-app')?.label).toBe('Legacy app connection · replaced by foreman-code')
      const upgrade = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: {
        harness, preset: 'graphql', installed: true, expectedRevision: before.revision, commandId: randomUUID() } }))))
      expect(upgrade.status).toBe('applied')
      expect(Object.keys(snapshots[harness].user)).toEqual(['foreman-code'])
      expect((await listed(harness)).presets?.graphql).toBe('installed')
      const installed = snapshots[harness].user['foreman-code']
      const workerHome = join(directory, 'worker')
      const workerRoot = join(workerHome, '.local/lib/graphql-worker')
      const stateDirectory = join(workerHome, '.local/state/graphql-worker')
      const releaseDirectory = join(workerRoot, 'versions/release')
      const workerLauncher = join(workerHome, '.local/share/graphql/mcp/launcher.mjs')
      const previousNode = join(directory, 'previous-worker-node')
      await copyFile(process.execPath, previousNode)
      await mkdir(join(releaseDirectory, 'artifacts'), { recursive: true, mode: 0o700 })
      await mkdir(join(workerHome, '.local/share/graphql/mcp'), { recursive: true, mode: 0o700 })
      const bridge = new URL('../../../scripts/graphql-mcp.mjs', import.meta.url)
      await copyFile(bridge, workerLauncher)
      const workerBridge = join(releaseDirectory, 'artifacts/graphql-mcp.mjs')
      await copyFile(bridge, workerBridge)
      await chmod(workerLauncher, 0o600)
      await chmod(workerBridge, 0o600)
      await writeFile(join(workerRoot, 'graphql-worker.service.previous'),
        `ExecStart=${previousNode} ${join(workerRoot, 'current/src/cli.mjs')} run --state ${stateDirectory}\n`,
        { mode: 0o600 })
      await registerWorkerMcpInstallation({ home: workerHome, stateDirectory, releaseDirectory })
      vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', join(workerHome, '.local/share/graphql/mcp'))
      const oldEntry = { ...installed as Record<string, unknown>, command: previousNode, args: [workerLauncher],
        startup_timeout_sec: 10, tool_timeout_sec: 30,
        timeout: 5000, custom_setting: { retained: true },
        enabled: false, disabled_tools: ['interaction_respond'] }
      const oldUser = { graphql: oldEntry }
      snapshots[harness] = { ...snapshots[harness], user: oldUser, effective: structuredClone(oldUser),
        revision: fingerprint(oldUser), }
      await writeFile(file, JSON.stringify(oldUser))
      expect((await listed(harness)).presets?.graphql).toBe('disabled')
      const repairArgs = {
        harness, preset: 'graphql', installed: true, expectedRevision: (await listed(harness)).revision, commandId: randomUUID(),
      }
      expect((await denied.callTool({ name: 'harness_mcp_managed_request', arguments: repairArgs })).isError).toBe(true)
      expect(snapshots[harness].user).toEqual(oldUser)
      const rename = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({
        name: 'harness_mcp_managed_request', arguments: repairArgs,
      }))))
      expect(rename).toMatchObject({ status: 'applied', change: { name: 'foreman-code' } })
      const renamed = await listed(harness)
      expect(renamed.presets?.graphql).toBe('disabled')
      expect(renamed.servers.map(server => server.name)).toEqual(['foreman-code'])
      expect(snapshots[harness].user['foreman-code']).toMatchObject({ command: process.execPath,
        args: [workerLauncher], enabled: false, disabled_tools: ['interaction_respond'],
        timeout: 5000, custom_setting: { retained: true },
        startup_timeout_sec: 60, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec })
      expect(JSON.parse(await readFile(file, 'utf8'))['foreman-code'])
        .toEqual(snapshots[harness].user['foreman-code'])
      const repairedUser = structuredClone(snapshots[harness].user)
      const retry = HarnessMcpPlanSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'harness_mcp_managed_request', arguments: repairArgs,
      })))
      expect(retry).toEqual(rename)
      expect(snapshots[harness].user).toEqual(repairedUser)
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(repairedUser)
    }
    inspectionFails = true
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 301_000)
    for (let attempt = 0; attempt < 2; attempt++) {
      const failed = await client.callTool({ name: 'harness_mcp_servers_list', arguments: { harness: 'codex' } })
      expect(failed.isError).toBe(true)
      expect(JSON.stringify(failed.content)).toContain('HARNESS_QUALIFICATION_FAILED')
    }
    const httpRefresh = await app.inject({ url: '/api/management/harnesses/codex/mcp',
      headers: { authorization: `Bearer ${owner.token}` } })
    expect(httpRefresh.statusCode).toBe(503)
    expect(httpRefresh.json()).toMatchObject({ error: { code: 'HARNESS_QUALIFICATION_FAILED' } })
    const beforeDenied = reads
    expect((await deniedReader.callTool({ name: 'harness_mcp_servers_list', arguments: { harness: 'codex' } })).isError)
      .toBe(true)
    expect(reads).toBe(beforeDenied)
    inspectionFails = false
    const recovered = HarnessMcpListResultSchema.parse(decodeMcpToolResult((await client.callTool({
      name: 'harness_mcp_servers_list', arguments: { harness: 'codex' },
    }))))
    expect(recovered.servers.map(server => server.name)).toEqual(['foreman-code'])
    expect(recovered.servers[0]?.enabled).toBe(false)
    const audits = await pool.query<{ principal_id: string; source: string }>("select principal_id,source from management_audit where action='harness.mcp.apply'")
    expect(audits.rows.length).toBeGreaterThan(0)
    expect(new Set(audits.rows.map((row) => `${row.principal_id}:${row.source}`))).toEqual(new Set([`${delegated.principal.id}:mcp`, `${delegated.principal.id}:http`]))
    vi.restoreAllMocks()
    const removal = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'harness_mcp_managed_request', arguments: {
      harness: 'codex', preset: 'graphql', installed: false, expectedRevision: recovered.revision, commandId: randomUUID(),
    } }))))
    expect(removal.status).toBe('applied')
    const missing = await listed('codex')
    held = await heldLauncher()
    const installing = new Promise<void>(resolve => { installLauncher = resolve })
    const installingArgs = { harness: 'codex', preset: 'graphql', installed: true,
      expectedRevision: missing.revision, commandId: randomUUID() }
    expect((await denied.callTool({ name: 'harness_mcp_managed_request', arguments: installingArgs })).isError).toBe(true)
    const pending = client.callTool({ name: 'harness_mcp_managed_request', arguments: installingArgs })
    await installing
    // eslint-disable-next-line no-restricted-syntax -- The held launcher must keep the MCP request pending throughout this observation window.
    expect(await Promise.race([pending.then(() => 'finished'), delay(10, 'waiting')])).toBe('waiting')
    await mcp.shutdown()
    const canceled = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await pending)))
    expect(canceled).toMatchObject({ status: 'pending', managedPreset: 'graphql' })
    const persisted = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await client.callTool({
      name: 'harness_mcp_change_get', arguments: { planId: canceled.id },
    }))))
    expect(persisted).toEqual(canceled)
    expect(persisted.error).toContain('not attempted')
    expect(snapshots.codex.user).toEqual({})
    const delivery = await pool.query<{ details: { delivery: string } }>(
      "select details from management_audit where action='harness.mcp.delivery_recorded' and details->>'planId'=$1", [canceled.id],
    )
    expect(delivery.rows).toEqual([{ details: expect.objectContaining({ delivery: 'not_submitted' }) }])
    await held.release()
    expect(await readFile(held.launcher, 'utf8')).toBe('original launcher')
  } finally {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    const stopping = mcp.shutdown()
    await held?.close()
    await stopping; await app.close(); await pool.end()
    await dropFixtureSchema(admin, schema); await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
