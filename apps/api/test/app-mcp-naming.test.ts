import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_MCP_TIMEOUTS, appLauncherConnection, appMcpServerName, isAppLauncher } from '../src/modules/harnesses/appMcpLauncher.js'
import { appMcpNeedsMigration, applyMcpEdits, assertChange, managedChange, managedEnableChange, managedStatus, mcpEdits,
  nativeConnection, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import { WorkerManagedMcp } from '../src/modules/harnesses/workerManagedMcp.js'
import { deviceManagedMcpFixture } from './helpers/deviceManagedMcp.js'

describe.each(['codex'] as const)('%s managed MCP naming', (harness) => {
  const endpoint = 'http://127.0.0.1:3000/mcp'
  const connection = (token: string) => nativeConnection({
    ...appLauncherConnection(), environmentVariables: [token],
  })
  const snapshot = (user: Record<string, unknown>): NativeMcpSnapshot => ({
    harness, revision: 'revision', effective: user, user, userConfig: {}, file: '/tmp/native-config', version: 'version',
  })
  const managed = { preset: 'graphql' as const, endpoint }
  const add = managedChange('graphql', true, endpoint)

  it.each(['foreman-code', 'graphql'])('writes timeouts without customizing the managed %s entry', name => {
    const entry = connection('FOREMAN_CODE_MCP_TOKEN')
    expect(entry).toMatchObject({ startup_timeout_sec: 60, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec })
    expect(isAppLauncher(entry)).toBe(true)
    expect(managedStatus(snapshot({ [name]: entry }), 'graphql')).toBe('installed')
    const old = { ...entry, startup_timeout_sec: 10, tool_timeout_sec: 30, enabled: false,
      disabled_tools: ['interaction_respond'] }
    const enabled = applyMcpEdits({ [name]: old }, mcpEdits(snapshot({ [name]: old }),
      managedEnableChange('graphql', true), managed))
    expect(enabled[name]).toEqual({ ...old, enabled: true, startup_timeout_sec: 60, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec })
    expect(managedStatus(snapshot(enabled), 'graphql')).toBe('installed')
  })

  it('repairs old launcher timeout settings while preserving native restrictions', () => {
    const old = { ...connection('GRAPHQL_MCP_TOKEN'), startup_timeout_sec: 10, tool_timeout_sec: 30,
      enabled: false, disabled_tools: ['interaction_respond'] }
    const repaired = applyMcpEdits({ graphql: old }, mcpEdits(snapshot({ graphql: old }), add, managed))
    expect(repaired['foreman-code']).toEqual({ ...old, ...connection('FOREMAN_CODE_MCP_TOKEN'), enabled: false })
    expect(repaired['foreman-code']).toMatchObject({ startup_timeout_sec: 60, tool_timeout_sec: APP_MCP_TIMEOUTS.tool_timeout_sec })
    expect(appMcpNeedsMigration(snapshot(repaired))).toBe(false)
    expect(() => mcpEdits(snapshot(repaired), add, managed)).toThrow('already has a native configuration')
  })

  it('installs one canonical connection with the new token reference', () => {
    expect(add.name).toBe('foreman-code')
    const installed = applyMcpEdits({}, mcpEdits(snapshot({}), add, managed))
    expect(installed).toEqual({ 'foreman-code': connection('FOREMAN_CODE_MCP_TOKEN') })
    expect(managedStatus(snapshot(installed), 'graphql')).toBe('installed')
  })

  it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])('keeps the supported old name usable with %s', (token) => {
    const entry = connection(token)
    expect(isAppLauncher(entry)).toBe(true)
    expect(appMcpServerName({ graphql: entry })).toBe('graphql')
    expect(managedStatus(snapshot({ graphql: entry }), 'graphql'))
      .toBe('installed')
    const disabled = applyMcpEdits({ graphql: entry }, mcpEdits(snapshot({ graphql: entry }),
      managedEnableChange('graphql', false), managed))
    expect(disabled).toEqual({ graphql: { ...entry, enabled: false } })
  })

  it('renames an owned entry in one reviewed write while retaining native policies and disabled state', () => {
    const entry = { ...connection('GRAPHQL_MCP_TOKEN'), enabled: false,
      enabled_tools: ['context_get'], disabled_tools: ['interaction_respond'],
      default_tools_approval_mode: 'prompt', tools: { context_get: { approval_mode: 'prompt' } },
      timeout: 5000, custom_setting: { retained: true } }
    const before = { graphql: entry, docs: { url: 'https://example.com/mcp' } }
    const after = applyMcpEdits(before, mcpEdits(snapshot(before), add, managed))
    expect(after).toEqual({ docs: before.docs, 'foreman-code': { ...entry, ...connection('FOREMAN_CODE_MCP_TOKEN'), enabled: false } })
    expect(managedStatus(snapshot(after), 'graphql')).toBe('disabled')
    expect(() => mcpEdits(snapshot(after), add, managed)).toThrow('already has a native configuration')
  })

  it.each([120, 300])('upgrades the previous %s-second managed deadline once during repeated readiness', async timeout => {
    const f = await deviceManagedMcpFixture()
    const entry = { ...connection('FOREMAN_CODE_MCP_TOKEN'), tool_timeout_sec: timeout, enabled: false,
      enabled_tools: ['context_get'], disabled_tools: ['interaction_respond'],
      default_tools_approval_mode: 'prompt', tools: { context_get: { approval_mode: 'prompt' } },
      timeout: 5000, custom_setting: { retained: true } }
    const before = { 'foreman-code': entry }
    expect(appMcpNeedsMigration(snapshot(before))).toBe(true)
    const worker = new WorkerManagedMcp({ directory: f.directory, adapters: f.adapters, installLauncher: async () => {} })
    try {
      await writeFile(join(f.directory, 'codex.json'), JSON.stringify(before))
      await worker.ensureReady(['codex'])
      const after = await f.adapters.codex.read(AbortSignal.timeout(5000))
      expect(after.user).toEqual({ 'foreman-code': { ...entry, ...APP_MCP_TIMEOUTS } })
      expect(appMcpNeedsMigration(after)).toBe(false)
      expect(f.writes()).toBe(1)
      await worker.ensureReady(['codex'])
      expect((await f.adapters.codex.read(AbortSignal.timeout(5000))).user).toEqual(after.user)
      expect(f.writes()).toBe(1)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  it('repairs its own launcher entry whose Node interpreter was removed, but not a customized one', () => {
    const stale = { ...connection('GRAPHQL_MCP_TOKEN'), command: '/removed/node/bin/node' }
    expect(isAppLauncher(stale)).toBe(false)
    const repaired = applyMcpEdits({ graphql: stale }, mcpEdits(snapshot({ graphql: stale }), add, managed))
    expect(repaired).toEqual({ 'foreman-code': connection('FOREMAN_CODE_MCP_TOKEN') })
    expect(managedStatus(snapshot(repaired), 'graphql')).toBe('installed')
    const customized = { ...stale, env: { EXTRA: 'value' } }
    expect(() => mcpEdits(snapshot({ graphql: customized }), add, managed)).toThrow('custom')
  })

  it('rejects name collisions, inherited entries, and custom authentication without editing either entry', () => {
    const entry = connection('GRAPHQL_MCP_TOKEN')
    const collision = { graphql: entry, 'foreman-code': { url: 'https://custom.example/mcp' } }
    expect(() => mcpEdits(snapshot(collision), add, managed)).toThrow('collision')
    expect(() => appMcpServerName(collision)).toThrow('collision')
    expect(() => mcpEdits({ ...snapshot({ graphql: entry }), ownership: { graphql: false } }, add, managed))
      .toThrow('already has')
    expect(() => mcpEdits(snapshot({ graphql: { ...entry, url: 'https://custom.example/mcp' } }), add, managed))
      .toThrow('custom')
    expect(collision.graphql).toEqual(entry)
    expect(() => assertChange(snapshot({}), { kind: 'add', name: 'custom', connection: {
      transport: 'remote', url: endpoint, bearerTokenEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN',
    } })).toThrow('managed by the server')
  })

  it('leaves customized retired entries untouched and retains disabled policies on supported retired connections', () => {
    const retired = nativeConnection({ transport: 'remote', url: 'http://127.0.0.1:3000/mcp/tools',
      bearerTokenEnvironmentVariable: 'GRAPHQL_APP_MCP_TOKEN' })
    const policy = { ...retired, enabled: false, disabled_tools: ['interaction_respond'] }
    const after = applyMcpEdits({ 'graphql-app': policy }, mcpEdits(snapshot({ 'graphql-app': policy }), add, managed))
    expect(after).toEqual({ 'foreman-code': { ...connection('FOREMAN_CODE_MCP_TOKEN'), enabled: false,
      disabled_tools: ['interaction_respond'] } })
    expect(() => mcpEdits(snapshot({ 'graphql-app': { url: 'https://custom.example/mcp' } }), add, managed)).toThrow('custom')
    expect(() => mcpEdits({ ...snapshot({ 'graphql-app': policy }), ownership: { 'graphql-app': false } }, add, managed))
      .toThrow('inherited')
  })

})
