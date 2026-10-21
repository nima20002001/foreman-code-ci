import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, vi } from 'vitest'
import { HarnessMcpListResultSchema, HarnessMcpPlanSchema, HarnessMcpPlanResultSchema } from '@foreman-code/contracts/management'
import { buildApp } from '../../src/app.js'
import { applyApplicationMigrations } from '../../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../../src/modules/harnesses/mcpSettings.js'
import { CodexMcpConnections } from '../../src/modules/harnesses/codexMcpConnections.js'
import { harnessBinaries } from '../../src/modules/harnesses/binaries.js'
import { assertCodexUnchanged, qualifyCodex } from '../../src/modules/harnesses/codexProtocol.js'
import * as nativeProcess from '../../src/modules/harnesses/process.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { createFixtureSchema, dropFixtureSchema } from './testResources.js'
import { withCodexNativeHome } from './codexNativeHome.js'

const initial = '# Preserve this comment\nmodel = "saved-model"\n\n[mcp_servers.docs]\n'
  + 'url = "https://example.invalid/mcp"\nenabled = false\n'
const external = initial.replace('saved-model', 'external-model')
export type NativeConfigFault = 'none' | 'external-before-write' | 'external-after-write'
  | 'crash-before-write' | 'crash-during-write' | 'crash-after-write'

interface NativeEvent {
  kind: string
  pid: number
  succeeded?: boolean
}

export async function runNativeConfigFault(fault: NativeConfigFault): Promise<void> {
  await withCodexNativeHome(async home => {
    const binary = process.env.CODEX_BINARY ?? harnessBinaries(process.env).codexBinary
    const file = join(home, 'config.toml')
    const faultFile = join(home, 'fault.json')
    const eventsFile = join(home, 'events.jsonl')
    const proxy = join(home, 'codex-proxy.cjs')
    const authBinary = join(home, 'codex-auth.cjs')
    const authSource = await readFile(new URL('../fixtures/codex-app-server.cjs', import.meta.url), 'utf8')
    await writeFile(authBinary, `#!${process.execPath}\n${authSource}`, { mode: 0o700 })
    const source = await readFile(new URL('../fixtures/codex-config-fault-proxy.cjs', import.meta.url), 'utf8')
    await writeFile(proxy, `#!${process.execPath}\n${source}`, { mode: 0o700 })
    await chmod(proxy, 0o700)
    await writeFile(file, initial, { mode: 0o600 })
    await writeFile(faultFile, JSON.stringify({ kind: fault, file, content: external }), { mode: 0o600 })
    await writeFile(eventsFile, '', { mode: 0o600 })
    vi.stubEnv('NATIVE_CONFIG_BINARY', binary)
    vi.stubEnv('NATIVE_CONFIG_EVENTS', eventsFile)
    vi.stubEnv('NATIVE_CONFIG_FAULT', faultFile)
    const events = async (): Promise<NativeEvent[]> => (await readFile(eventsFile, 'utf8')).trim().split('\n')
      .filter(Boolean).map(line => JSON.parse(line) as NativeEvent)
    const assertClosed = async () => {
      const observed = await events()
      const started = observed.filter(event => event.kind === 'start').map(event => event.pid)
      const closed = new Set(observed.filter(event => event.kind === 'close').map(event => event.pid))
      expect(started.length).toBeGreaterThan(0)
      for (const pid of started) {
        expect(closed.has(pid)).toBe(true)
        expect(() => process.kill(pid, 0)).toThrow()
      }
    }
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
    const schema = `native_config_${randomUUID().replaceAll('-', '')}`
    let pool: pg.Pool | undefined
    let service: HarnessMcpSettingsService | undefined
    let app: ReturnType<typeof buildApp> | undefined
    let schemaCreated = false
    let scenarioFailure: { error: unknown } | undefined
    const cleanupFailures: unknown[] = []
    const clients: Client[] = []
    const runCommand = nativeProcess.runCommand
    // Use fixture authentication while retaining native configuration and schema operations.
    const authentication = vi.spyOn(nativeProcess, 'runCommand').mockImplementation((command, args, ...rest) => {
      const authProbe = args.length === 2 && args[0] === 'login' && args[1] === 'status'
      return runCommand(authProbe ? authBinary : command, args, ...rest)
    })
    try {
      const qualified = await qualifyCodex(binary, home, { ...process.env }, true, AbortSignal.timeout(120_000))
      vi.stubEnv('NATIVE_CONFIG_BINARY', qualified.binary)
      await createFixtureSchema(admin, schema)
      schemaCreated = true
      pool = new pg.Pool({ ...admin.options, options: `-c search_path=${schema}` })
      await applyApplicationMigrations(pool)
      const adapter = new CodexMcpConnections(proxy, home)
      const commands = new PostgresCommandCoordinator(pool)
      const access = new PostgresAccessService(pool)
      service = new HarnessMcpSettingsService(pool, commands, { codex: adapter }, () => {}, assertClosed)
      const services = { commands, harnessSettings: { mcp: service, directories: {} } } as unknown as OperatorServices
      app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services } })
      const owner = await access.issue({ name: 'Native config writer', audience: 'operator',
        grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
        expiresAt: new Date(Date.now() + 600_000) })
      const reader = await access.issue({ name: 'Native config reader', audience: 'operator',
        grants: [{ actions: ['harnesses:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      let address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'native-config-fault-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => token } }))
        return client
      }
      let ownerClient = await connect(owner.token)
      const denied = await connect(reader.token)
      const before = await adapter.read(AbortSignal.timeout(120_000))
      const input = { harness: 'codex', commandId: randomUUID(), expectedRevision: before.revision,
        change: { kind: 'remove', name: 'docs' } }
      const request = { name: 'harness_mcp_change_request', arguments: input }
      expect((await denied.callTool(request)).isError).toBe(true)
      expect((await events()).filter(event => event.kind === 'write-request')).toHaveLength(0)
      const result = HarnessMcpPlanSchema.parse(decodeMcpToolResult((await ownerClient.callTool(request, { timeout: 150_000 }))))
      expect(result.status).toBe(fault === 'none' ? 'applied' : 'uncertain')
      const readPlan = async () => HarnessMcpPlanSchema.parse(decodeMcpToolResult((await ownerClient.callTool({
        name: 'harness_mcp_change_get', arguments: { planId: result.id },
      }))))
      expect(await readPlan()).toEqual(result)
      expect(HarnessMcpPlanSchema.parse(decodeMcpToolResult((await ownerClient.callTool(request))))).toEqual(result)
      expect((await events()).filter(event => event.kind === 'write-request')).toHaveLength(1)
      const backups = (await readdir(home)).filter(name => name.endsWith('.bak'))
      expect(backups).toHaveLength(1)
      expect(await readFile(join(home, backups[0]!), 'utf8')).toBe(initial)
      const observed = await adapter.read(AbortSignal.timeout(120_000))
      const hasDocs = Object.hasOwn(observed.user, 'docs')
      if (fault === 'none' || fault === 'crash-after-write') expect(hasDocs).toBe(false)
      if (fault === 'crash-before-write' || fault.startsWith('external-')) expect(hasDocs).toBe(true)
      expect(observed.userConfig.model).toBe(fault.startsWith('external-') ? 'external-model' : 'saved-model')
      expect(await readFile(file, 'utf8')).toContain('# Preserve this comment')
      if (fault === 'crash-after-write') {
        expect((await events()).find(event => event.kind === 'write-response')?.succeeded).toBe(true)
      }
      await service.shutdown()
      for (const client of clients.splice(0)) await client.close()
      await app.close()
      service = new HarnessMcpSettingsService(pool, commands, { codex: adapter }, () => {}, assertClosed)
      services.harnessSettings!.mcp = service
      await service.recover()
      app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services } })
      address = await app.listen({ host: '127.0.0.1', port: 0 })
      ownerClient = await connect(owner.token)
      expect(await readPlan()).toEqual(result)
      const readback = HarnessMcpListResultSchema.parse(decodeMcpToolResult((await ownerClient.callTool({
        name: 'harness_mcp_servers_list', arguments: { harness: 'codex' },
      }, { timeout: 150_000 }))))
      expect(readback.revision).toBe(observed.revision)
      expect(readback.servers.some(server => server.name === 'docs')).toBe(hasDocs)
      if (result.status === 'uncertain') {
        const reconcile = { planId: result.id, commandId: randomUUID(), expectedRevision: observed.revision,
          acceptObservedState: false }
        const matches = !hasDocs && observed.userConfig.model === 'saved-model'
        const reconcileRequest = { name: 'harness_mcp_change_reconcile', arguments: reconcile }
        const settled = await ownerClient.callTool(reconcileRequest, { timeout: 150_000 })
        if (matches) {
          const settlement = HarnessMcpPlanResultSchema.parse(decodeMcpToolResult(settled))
          expect(settlement.value.status).toBe('applied')
          const replay = HarnessMcpPlanResultSchema.parse(decodeMcpToolResult((await ownerClient.callTool(reconcileRequest))))
          expect(replay).toEqual({ ...settlement, replayed: true })
        } else {
          expect(settled.isError).toBe(true)
          expect((await readPlan()).status).toBe('uncertain')
          const accepted = await ownerClient.callTool({ name: 'harness_mcp_change_reconcile',
            arguments: { ...reconcile, commandId: randomUUID(), acceptObservedState: true } }, { timeout: 150_000 })
          expect(HarnessMcpPlanResultSchema.parse(decodeMcpToolResult(accepted)).value.status).toBe('reconciled')
        }
        expect((await readPlan()).status).toBe(matches ? 'applied' : 'reconciled')
        const audit = await pool.query<{ source: string; details: { nativeWriteRepeated: boolean } }>(
          "select source,details from management_audit where action='harness.mcp.reconciliation_recorded' and details->>'planId'=$1",
          [result.id],
        )
        expect(audit.rows).toEqual([{ source: 'mcp', details: expect.objectContaining({ nativeWriteRepeated: false }) }])
      }
      expect((await events()).filter(event => event.kind === 'write-request')).toHaveLength(1)
      await assertCodexUnchanged(qualified)
      await assertClosed()
    } catch (error) {
      scenarioFailure = { error }
    } finally {
      const cleanup: PromiseSettledResult<unknown>[] = await Promise.allSettled(clients.map(client => client.close()))
      cleanup.push(...await Promise.allSettled([service?.shutdown(), app?.close()]))
      cleanup.push(...await Promise.allSettled([pool?.end()]))
      if (schemaCreated) cleanup.push(...await Promise.allSettled([dropFixtureSchema(admin, schema)]))
      cleanup.push(...await Promise.allSettled([admin.end()]))
      authentication.mockRestore()
      vi.unstubAllEnvs()
      cleanupFailures.push(...cleanup.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []))
    }
    if (cleanupFailures.length) {
      if (scenarioFailure) cleanupFailures.unshift(scenarioFailure.error)
      throw new AggregateError(cleanupFailures, 'Native config scenario cleanup failed',
        { cause: scenarioFailure?.error })
    }
    if (scenarioFailure) throw scenarioFailure.error
  })
}
