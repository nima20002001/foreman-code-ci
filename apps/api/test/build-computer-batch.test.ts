import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { BuildComputerBatchResultSchema, type BuildComputerChange } from '@foreman-code/contracts/build-computers'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { BuildComputerSettings, buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { deferred } from './helpers/deferred.js'
import { DomainError } from '../src/modules/errors.js'

const mainId = '11111111-1111-4111-8111-111111111111'
const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] }
const reader: ManagementPrincipal = { ...owner, id: 'reader',
  grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
const scoped: ManagementPrincipal = { ...owner, id: 'scoped',
  grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: { workspaceIds: ['workspace'] } }] }
const principals = new Map([owner, reader, scoped].map(principal => [principal.id, principal]))
const registrations = [2, 3, 4].map(index => ({ mainId,
  deviceId: `${index}`.repeat(8) + '-2222-4222-8222-222222222222',
  workerInstallationId: `${index}`.repeat(8) + '-3333-4333-8333-333333333333',
  keyRevision: 1, authorizationRevision: 1, status: 'paired',
  publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }))
const targets = [{ hostRef: { kind: 'main' as const, mainId }, applicationInstallationId: mainId,
  keyRevision: null, authorizationRevision: null }, ...registrations.map(registration => ({
  hostRef: { kind: 'device' as const, mainId, deviceId: registration.deviceId },
  applicationInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
}))]
type PreferenceRow = { target: unknown; revision: string; build_enabled: boolean; build_priority: number;
  build_allowance_percent: number }
type ReceiptRow = { input_hash: unknown; target_key: unknown; result: unknown }

async function fixture() {
  const pool = new pg.Pool()
  let preferences = new Map<string, PreferenceRow>()
  let receipts = new Map<string, ReceiptRow>()
  const buildLocks = new Set<object>()
  let failReceipt = false
  const audits: { principal: unknown; source: unknown; action: unknown; outcome: string }[] = []
  const readExternal = async (text: string, values: unknown[]) => {
    if (text.includes('management_audit')) {
      let outcome = 'succeeded'
      if (values.length === 6) outcome = String(values[4])
      else if (text.includes("'denied'")) outcome = 'denied'
      audits.push({ principal: values[0], source: values[1], action: values[2], outcome })
    }
    return { rows: [] }
  }
  vi.spyOn(pool, 'query').mockImplementation(readExternal as unknown as typeof pool.query)
  vi.spyOn(pool, 'connect').mockImplementation((async () => {
    const session = {}
    let transactionPreferences = preferences
    let transactionReceipts = receipts
    const query = async (text: string, values: unknown[] = []) => {
      if (text === 'begin') {
        transactionPreferences = new Map(preferences)
        transactionReceipts = new Map(receipts)
      }
      if (text === 'commit') { preferences = transactionPreferences; receipts = transactionReceipts }
      if (text === 'commit' || text === 'rollback') buildLocks.delete(session)
      if (text.includes('pg_advisory_xact_lock') && String(values[0]).startsWith('build-order:')) {
        buildLocks.add(session)
      }
      if (text.includes('from management_principals')) {
        const principal = principals.get(String(values[0]))!
        return { rows: [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
      }
      if (text.includes('from application_installation')) return { rows: [{ id: mainId }] }
      if (text.includes('from device_registrations')) {
        return { rows: [{ record: registrations.find(registration => registration.deviceId === values[0]) }] }
      }
      if (text.includes('from build_computer_preferences')) {
        const row = transactionPreferences.get(String(values[0]))
        return { rows: row ? [row] : [] }
      }
      if (text.includes('insert into build_computer_preferences')) {
        transactionPreferences.set(String(values[0]), { target: JSON.parse(String(values[1])), revision: String(values[2]),
          build_enabled: Boolean(values[3]), build_priority: Number(values[4]),
          build_allowance_percent: Number(values[5]) })
      }
      if (text.includes('from management_command_receipts')) {
        const row = transactionReceipts.get(values.slice(0, 3).join(':'))
        return { rows: row ? [row] : [] }
      }
      if (text.includes('insert into management_command_receipts')) {
        if (failReceipt) { failReceipt = false; throw new Error('Receipt write failed') }
        transactionReceipts.set(values.slice(0, 3).join(':'), { target_key: values[3], input_hash: values[4],
          result: JSON.parse(String(values[5])) })
      }
      return readExternal(text, values)
    }
    return { query, release() {} }
  }) as unknown as typeof pool.connect)
  const changed = vi.fn()
  const readiness = vi.fn<ConstructorParameters<typeof BuildComputerSettings>[2]>(async () => ({ state: 'ready' as const, reasons: [], remoteExecutionEnabled: true }))
  const commands = new PostgresCommandCoordinator(pool)
  const settings = new BuildComputerSettings(pool, commands, readiness, changed)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    const principal = principals.get(token ?? '')
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Invalid bearer.', 401)
    return principal
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { buildComputers: settings, commands } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'build-order-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => token } }))
    return client
  }
  const updates: BuildComputerChange[] = targets.map((target, index) => ({ target, expectedRevision: 0,
    buildEnabled: true, buildPriority: 100 - index * 20, buildAllowancePercent: 60 }))
  return { app, settings, connect, changed, readiness, audits, updates,
    failReceipt: () => { failReceipt = true },
    committed: () => [...preferences.values()],
    canChangeBuildOrder: () => buildLocks.size === 0,
    close: async () => { await Promise.all(clients.map(client => client.close())); await app.close(); await pool.end() } }
}
afterEach(() => vi.restoreAllMocks())

it('saves one order through authenticated MCP, replays it and reads persisted settings with denied callers', async () => {
  const f = await fixture()
  try {
    const client = await f.connect('owner')
    const readOnly = await f.connect('reader')
    const command = { commandId: 'save-order', updates: f.updates }
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('build_computers_update')
    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({ requirements: expect.arrayContaining([
      expect.objectContaining({ name: 'build_computers_update', actions: ['settings:update'] }),
    ]) })
    const saved = BuildComputerBatchResultSchema.parse(decodeMcpToolResult((await client.callTool({
      name: 'build_computers_update', arguments: command,
    }))))
    expect(saved.computers.map(status => status.preference)).toEqual(f.updates.map(({ expectedRevision, ...change }) => ({
      ...change, revision: expectedRevision + 1,
    })))
    const replay = await client.callTool({ name: 'build_computers_update', arguments: command })
    expect(decodeMcpToolResult(replay)).toEqual(saved)
    expect(f.changed).toHaveBeenCalledTimes(1)
    expect((await readOnly.listTools()).tools.map(tool => tool.name)).not.toContain('build_computers_update')
    const denied = await readOnly.callTool({ name: 'build_computers_update', arguments: command })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const scopedClient = await f.connect('scoped')
    expect((await scopedClient.callTool({ name: 'build_computers_update', arguments: command })).isError).toBe(true)
    for (const status of saved.computers) {
      expect(decodeMcpToolResult((await readOnly.callTool({ name: 'build_computer_get', arguments: { target: status.preference.target } })))).toEqual(status)
    }
    expect(f.audits).toContainEqual({ principal: 'owner', source: 'mcp', action: 'build.computers.update', outcome: 'succeeded' })
    expect(f.audits).toContainEqual({ principal: 'reader', source: 'mcp', action: 'build_computers_update', outcome: 'denied' })
  } finally { await f.close() }
})
it('leaves every computer unchanged and does not wake scheduling when the last revision conflicts', async () => {
  const f = await fixture()
  try {
    const before = await Promise.all(targets.map(target => f.settings.read(owner, { target })))
    await expect(f.settings.updateBatch(owner, 'http', { commandId: 'conflicting-order',
      updates: f.updates.map((change, index) => ({ ...change, expectedRevision: index === 3 ? 9 : 0 })),
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await Promise.all(targets.map(target => f.settings.read(owner, { target })))).toEqual(before)
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.audits.filter(audit => audit.action === 'build.computers.update')).toEqual([
      { principal: 'owner', source: 'http', action: 'build.computers.update', outcome: 'failed' },
    ])
  } finally { await f.close() }
})
it('rolls back the whole transaction after a failure following the writes and permits retrying the same command', async () => {
  const f = await fixture()
  try {
    const before = await Promise.all(targets.map(target => f.settings.read(owner, { target })))
    const command = { commandId: 'interrupted-order', updates: f.updates }
    f.failReceipt()
    await expect(f.settings.updateBatch(owner, 'http', command)).rejects.toThrow('Receipt write failed')
    expect(await Promise.all(targets.map(target => f.settings.read(owner, { target })))).toEqual(before)
    expect(f.changed).not.toHaveBeenCalled()
    const saved = await f.settings.updateBatch(owner, 'http', command)
    expect(saved.computers.map(status => status.preference.revision)).toEqual([1, 1, 1, 1])
    expect(new Set(saved.computers.map(status => buildComputerKey(status.preference.target))).size).toBe(4)
    expect(f.changed).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('returns a readiness observation after releasing the build-order read lock', async () => {
  const f = await fixture()
  try {
    await f.settings.updateBatch(owner, 'http', { updates: f.updates })
    f.readiness.mockImplementation(async () => ({ state: f.canChangeBuildOrder() ? 'ready' : 'busy',
      reasons: [], remoteExecutionEnabled: true }))
    expect(await f.settings.read(owner, { target: targets[1] })).toMatchObject({ state: 'ready' })
  } finally { await f.close() }
})

it('returns committed preferences and per-computer unavailable readiness after a disconnected observation', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let pending: ReturnType<typeof f.settings.updateBatch> | undefined
  try {
    f.readiness.mockImplementation(async (_sql, target) => {
      if (buildComputerKey(target) !== buildComputerKey(targets[1]!)) {
        return { state: 'ready', reasons: [], remoteExecutionEnabled: true }
      }
      entered.resolve()
      await release.promise
      throw new Error('Computer disconnected during readiness')
    })
    const command = { commandId: 'save-with-disconnected-observation', updates: f.updates }
    const client = await f.connect('owner')
    pending = client.callTool({ name: 'build_computers_update', arguments: command })
      .then(result => BuildComputerBatchResultSchema.parse(decodeMcpToolResult(result)))
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    await entered.promise
    expect(f.committed().map(row => row.revision)).toEqual(['1', '1', '1', '1'])
    expect(f.canChangeBuildOrder()).toBe(true)
    release.resolve()
    const completed = await outcome
    expect(completed).toMatchObject({ value: { computers: [
      { preference: { revision: 1 }, state: 'ready' },
      { preference: { revision: 1 }, state: 'offline', reasons: ['Readiness unavailable: Computer disconnected during readiness'] },
      { preference: { revision: 1 }, state: 'ready' },
      { preference: { revision: 1 }, state: 'ready' },
    ] } })
    expect(await f.settings.updateBatch(owner, 'mcp', command)).toEqual('value' in completed ? completed.value : undefined)
    f.readiness.mockResolvedValue({ state: 'ready', reasons: [], remoteExecutionEnabled: true })
    const replay = await f.settings.updateBatch(owner, 'mcp', command)
    expect(replay.computers.map(computer => computer.preference.revision)).toEqual([1, 1, 1, 1])
    expect(f.changed).toHaveBeenCalledTimes(1)
    for (const computer of replay.computers) {
      expect(await f.settings.read(reader, { target: computer.preference.target })).toEqual(computer)
    }
  } finally {
    release.resolve()
    if (pending) await Promise.allSettled([pending])
    await f.close()
  }
})


it('returns a committed single-computer disable when its readiness probe fails', async () => {
  const f = await fixture()
  try {
    f.readiness.mockRejectedValue(new Error('Readiness transport unavailable'))
    const command = { commandId: 'disable-disconnected-computer', ...f.updates[1]!, buildEnabled: false }
    const saved = await f.settings.update(owner, 'http', command)
    expect(saved).toMatchObject({ preference: { revision: 1, buildEnabled: false },
      state: 'disabled', reasons: ['Enable builds to participate.'] })
    expect(await f.settings.update(owner, 'http', command)).toEqual(saved)
    expect(f.changed).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})
