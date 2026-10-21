import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HarnessMcpListResultSchema, HarnessMcpPlanSchema } from '@foreman-code/contracts/management'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CodexMcpConnections } from '../src/modules/harnesses/codexMcpConnections.js'

const native = vi.hoisted(() => ({ file: '', user: {} as Record<string, unknown>, version: 1 }))
vi.mock('../src/modules/harnesses/codexProtocol.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexProtocol.js')>(),
  qualifyCodex: async () => ({ binary: '/fixture/codex', protocol: {} }),
  assertCodexUnchanged: async () => {},
}))
vi.mock('../src/modules/harnesses/process.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/process.js')>(),
  runCommand: async () => ({ exitCode: 0, stderr: '', stdout: JSON.stringify(
    Object.entries(native.user).map(([name, value]) => ({ name, enabled: true,
      transport: { type: 'streamable_http', ...value as object } }))) }),
}))
vi.mock('../src/modules/harnesses/codexStdioTransport.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/modules/harnesses/codexStdioTransport.js')>(),
  CodexStdioTransport: class {
    async start() {}
    async close() {}
    async request(method: string, params: { filePath: string; edits: { value: unknown }[] }) {
      if (method === 'config/read') return { layers: [{ name: { type: 'user', file: native.file },
        version: String(native.version), config: { mcp_servers: native.user } }] }
      if (method !== 'config/batchWrite') throw new Error('Unexpected native operation')
      native.user = { logs: params.edits[0]!.value }
      const staging = `${params.filePath}.writing`
      await writeFile(staging, JSON.stringify(native.user))
      await rename(staging, params.filePath)
      native.version++
      return {}
    }
  },
}))

it.each(['directory', 'file'] as const)('writes through a same-user %s link and preserves it', async kind => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'codex-config-link-'))
  const database = await agent3Database()
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const adapter = new CodexMcpConnections('/fixture/codex', directory)
  const mcp = new HarnessMcpSettingsService(database.pool, commands, { codex: adapter }, () => {})
  const services = { commands, harnessSettings: { mcp, directories: {} } } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services } })
  const clients: Client[] = []
  try {
    const actual = join(directory, 'actual')
    await mkdir(actual)
    const target = join(actual, 'config.toml')
    await writeFile(target, '{}', { mode: 0o600 })
    const linked = join(directory, kind === 'directory' ? 'linked' : 'config.toml')
    await symlink(kind === 'directory' ? actual : target, linked)
    native.file = kind === 'directory' ? join(linked, 'config.toml') : linked
    native.user = {}
    native.version = 1
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (actions: ('harnesses:read' | 'harnesses:update')[]) => {
      const issued = await access.issue({ name: 'Configuration caller', audience: 'operator',
        grants: [{ actions, scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const client = new Client({ name: 'linked-config-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => issued.token },
      }))
      return client
    }
    const writer = await connect(['harnesses:read', 'harnesses:update'])
    const reader = await connect(['harnesses:read'])
    const list = async () => HarnessMcpListResultSchema.parse(decodeMcpToolResult(
      await writer.callTool({ name: 'harness_mcp_servers_list', arguments: { harness: 'codex' } })))
    const before = await list()
    const args = { harness: 'codex', commandId: randomUUID(), expectedRevision: before.revision,
      change: { kind: 'add', name: 'logs', connection: { transport: 'remote', url: 'https://example.test/mcp' } } }
    const denied = await reader.callTool({ name: 'harness_mcp_change_request', arguments: args })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await readFile(target, 'utf8')).toBe('{}')
    const applied = HarnessMcpPlanSchema.parse(decodeMcpToolResult(
      await writer.callTool({ name: 'harness_mcp_change_request', arguments: args })))
    expect(applied.status).toBe('applied')
    expect(decodeMcpToolResult(await writer.callTool({ name: 'harness_mcp_change_get',
      arguments: { planId: applied.id } }))).toEqual(applied)
    expect((await list()).servers).toContainEqual(expect.objectContaining({ name: 'logs', enabled: true }))
    expect((await lstat(linked)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ logs: { url: 'https://example.test/mcp', enabled: true } })
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await mcp.shutdown()
    await app.close()
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})
