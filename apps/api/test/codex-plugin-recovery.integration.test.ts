import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CodexPluginSettingsService } from '../src/modules/harnesses/codexPluginSettings.js'
import { HarnessMcpSettingsService } from '../src/modules/harnesses/mcpSettings.js'
import { normalizeCodexPluginCatalog } from '../src/modules/harnesses/codexPluginCatalog.js'
import { assertNoUnresolvedMcpWrites, assertNoUnresolvedPluginWrites, NATIVE_SETTINGS_LOCK } from '../src/modules/harnesses/nativeSettingsWrites.js'
import type { CodexPluginAdapter } from '../src/modules/harnesses/codexPlugins.js'
import type { NativeMcpAdapter } from '../src/modules/harnesses/nativeMcpCommon.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })
async function fixture(initiallyInstalled = false) {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
  const schema = `plugin_recovery_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL!, options: `-c search_path=${schema}` })
  const root = await mkdtemp(join(tmpdir(), 'plugin-recovery-'))
  const file = join(root, 'config.toml'); await writeFile(file, '')
  cleanups.push(async () => { await pool.end(); await dropFixtureSchema(admin, schema); await admin.end(); await removeFixtureDirectory(root) })
  await applyApplicationMigrations(pool)
  const owner = (await new PostgresAccessService(pool).issue({ name: 'Owner', audience: 'operator',
    grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }], expiresAt: new Date(Date.now() + 120_000) })).principal
  const state = { installed: initiallyInstalled, omit: false, partial: false, fail: false, source: 'source-a', preserve: true }
  const mcp = { linear: { url: 'https://example.test/mcp', enabled_tools: ['read'], disabled_tools: ['write'], default_tools_approval_mode: 'prompt' } }
  const read = async () => {
    const entry = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1.0.0', installed: state.installed, enabled: state.installed,
      source: { source: 'remote', id: state.source }, installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' }
    return normalizeCodexPluginCatalog({ installed: state.installed && !state.omit ? [entry] : [], available: !state.installed && !state.omit ? [entry] : [] },
      { file, userConfig: { mcp_servers: state.preserve ? structuredClone(mcp) : {}, plugins: state.installed ? { [entry.pluginId]: { enabled: true } } : {} } },
      state.partial ? 'partial' : 'complete')
  }
  const mutate = vi.fn(async (_id: string, action: 'install' | 'remove') => {
    if (state.fail) { state.partial = true; state.omit = true; throw new Error('remote failed') }
    state.installed = action === 'install'
    return { acknowledged: true as const, version: state.installed ? '1.0.0' : null }
  })
  const cleanup = vi.fn(async () => {})
  const adapter: CodexPluginAdapter = { recoveryIdentity: 'fixture-writer', list: read, detail: async () => ({ status: 'unknown' }), change: mutate }
  const service = new CodexPluginSettingsService(pool, adapter, cleanup)
  cleanups.push(() => service.shutdown())
  const review = async (action: 'install' | 'remove') => {
    const detail = await service.get(owner, 'notes@trusted')
    return { pluginId: 'notes@trusted', action, expectedRevision: detail.revision, artifactIdentity: detail.artifactIdentity, commandId: randomUUID() }
  }
  return { pool, owner, state, mcp, read, adapter, mutate, cleanup, service, review }
}
it('never reports a failed remote removal as applied after a partial exit-zero catalog', async () => {
  const f = await fixture(true)
  const input = await f.review('remove'); f.state.fail = true
  const result = await f.service.change(f.owner, input)
  expect(result).toMatchObject({ status: 'uncertain', nativeFailure: 'CODEX_PLUGIN_NATIVE_UNCONFIRMED' })
  expect(f.state.installed).toBe(true)
  expect((await f.service.change(f.owner, input)).status).toBe('uncertain')
  expect(f.mutate).toHaveBeenCalledTimes(1)
  const audit = await f.pool.query("select 1 from management_audit where action='codex.plugin.readback' and outcome='succeeded' and details->>'commandId'=$1", [input.commandId])
  expect(audit.rowCount).toBe(0)
  const list = await f.service.list(f.owner, { view: 'installed', query: '', limit: 24, offset: 0 })
  expect(list.items).toMatchObject([{ pluginId: input.pluginId, verification: 'unverified' }])
})
it('blocks every new command until explicit reconciliation and never repeats the write', async () => {
  const f = await fixture(true)
  const input = await f.review('remove'); f.state.fail = true
  await f.service.change(f.owner, input)
  await expect(f.service.change(f.owner, { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'CODEX_PLUGIN_RECONCILIATION_REQUIRED' })
  const client = await f.pool.connect()
  try { await expect(assertNoUnresolvedPluginWrites(client)).rejects.toMatchObject({ code: 'CODEX_PLUGIN_RECONCILIATION_REQUIRED' }) }
  finally { client.release() }
  const observed = await f.service.reconcile(f.owner, { commandId: input.commandId, acceptObservedState: false })
  expect(observed.status).toBe('uncertain'); expect(observed.observedRevision).toBeDefined()
  const settled = await f.service.reconcile(f.owner, { commandId: input.commandId, acceptObservedState: true, expectedRevision: observed.observedRevision! })
  expect(settled.status).toBe('reconciled')
  expect((await f.service.operations(f.owner)).items).toEqual([])
  expect(f.mutate).toHaveBeenCalledTimes(1)
  expect((await f.service.change(f.owner, input)).status).toBe('reconciled')
})
it('refuses stale source reviews and retains unrelated native configuration', async () => {
  const f = await fixture()
  const stale = await f.review('install'); f.state.source = 'source-b'
  await expect(f.service.change(f.owner, stale)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.mutate).not.toHaveBeenCalled()
  const input = await f.review('install')
  expect((await f.service.change(f.owner, input)).status).toBe('applied')
  expect((await f.read()).configuration.userConfig.mcp_servers).toEqual(f.mcp)
})
it('does not confirm a plugin mutation that altered unrelated MCP restrictions', async () => {
  const f = await fixture()
  const input = await f.review('install')
  f.mutate.mockImplementationOnce(async () => { f.state.installed = true; f.state.preserve = false; return { acknowledged: true, version: '1.0.0' } })
  expect((await f.service.change(f.owner, input)).status).toBe('uncertain')
})
it('uses the same lock as real MCP decisions while a plugin writer is paused', async () => {
  const f = await fixture()
  let release!: () => void; let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  f.mutate.mockImplementationOnce(async () => { entered(); await gate; f.state.installed = true; return { acknowledged: true, version: '1.0.0' } })
  const input = await f.review('install')
  const changing = f.service.change(f.owner, input)
  const unused = { read: vi.fn(), apply: vi.fn() } as unknown as NativeMcpAdapter
  const mcp = new HarnessMcpSettingsService(f.pool, new PostgresCommandCoordinator(f.pool), { codex: unused }, () => {})
  try {
    await started
    // A nonexistent plan is intentional: the shared lock must reject before plan lookup or native reads.
    await expect(mcp.decide(f.owner, randomUUID(), true)).rejects.toMatchObject({ code: 'MCP_SETTINGS_BUSY' })
    const client = await f.pool.connect()
    try { expect((await client.query('select pg_try_advisory_lock(hashtext($1)) as locked', [NATIVE_SETTINGS_LOCK])).rows[0].locked).toBe(false) }
    finally { client.release() }
  } finally { release(); await changing; await mcp.shutdown() }
  expect((await f.read()).configuration.userConfig.mcp_servers).toEqual(f.mcp)
})
it('blocks plugins on unresolved MCP writes before entering the native adapter', async () => {
  const f = await fixture()
  // Use the same SQL predicate as the service; create a native-plan row through the migration schema.
  await f.pool.query(`insert into harness_mcp_change_plans(id,harness,revision,change,requested_by,status,expires_at)
    values($1,'codex',$2,'{}'::jsonb,$3,'uncertain',now()+interval '10 minutes')`, [randomUUID(), 'sha256:' + 'a'.repeat(64), f.owner.id])
  const client = await f.pool.connect()
  try { await expect(assertNoUnresolvedMcpWrites(client)).rejects.toMatchObject({ code: 'MCP_RECONCILIATION_REQUIRED' }) }
  finally { client.release() }
  await expect(f.service.change(f.owner, await f.review('install'))).rejects.toMatchObject({ code: 'MCP_RECONCILIATION_REQUIRED' })
  expect(f.mutate).not.toHaveBeenCalled()
})
it('recovers the old writer on restart, retains its receipt, and quarantines failed cleanup', async () => {
  const f = await fixture()
  const input = await f.review('install'); f.state.fail = true
  await f.service.change(f.owner, input)
  const cleanup = vi.fn(async (): Promise<void> => { throw new Error('surviving writer') })
  const restarted = new CodexPluginSettingsService(f.pool, f.adapter, cleanup)
  await expect(restarted.recover()).rejects.toThrow('surviving writer')
  await expect(restarted.reconcile(f.owner, { commandId: input.commandId, acceptObservedState: false })).rejects.toThrow('surviving writer')
  await expect(restarted.change(f.owner, { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'CODEX_PLUGIN_RECONCILIATION_REQUIRED' })
  cleanup.mockImplementation(async () => {})
  await restarted.recover()
  expect((await restarted.change(f.owner, input)).status).toBe('uncertain')
  expect(f.mutate).toHaveBeenCalledTimes(1)
  await restarted.shutdown()
})
