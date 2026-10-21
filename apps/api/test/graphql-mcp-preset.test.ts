import { describe, expect, it } from 'vitest'
import { applyMcpEdits, managedChange, managedStatus, mcpEdits, nativeConnection, replacement, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'

describe.each(['codex'] as const)('%s graphql preset', (harness) => {
  const endpoint = 'http://127.0.0.1:3002/mcp'
  const snapshot = (user: Record<string, unknown>): NativeMcpSnapshot => ({ harness, revision: 'revision', file: '/tmp/config', version: '1',
    userConfig: {}, user, effective: user, })
  const change = managedChange('graphql', true, endpoint)
  const managed = { preset: 'graphql' as const, endpoint }
  const launcher = nativeConnection(appLauncherConnection())
  it('migrates the standard fixed route while retaining disabled and native tool policies', () => {
    const fixed = { ...nativeConnection({ transport: 'remote', url: 'http://127.0.0.1:3012/mcp',
      bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN' }), enabled: false, disabled_tools: ['interaction_respond'] }
    const migrated = replacement(snapshot({ graphql: fixed }), change, managed)!
    expect(migrated).toEqual({ ...launcher, enabled: false, disabled_tools: ['interaction_respond'] })
    expect(managedStatus(snapshot({ 'foreman-code': migrated }), 'graphql', endpoint)).toBe('disabled')
    expect(managedStatus(snapshot({ 'foreman-code': { ...migrated, enabled: true } }), 'graphql', 'http://127.0.0.1:9999/mcp')).toBe('installed')
  })
  it('replaces the retired graphql-app and graphql-operator entries in the same write', () => {
    const legacy = { 'graphql-app': { enabled: true }, 'graphql-operator': { enabled: true }, linear: { url: 'https://mcp.linear.app/mcp/readonly' } }
    expect(managedStatus(snapshot(legacy), 'graphql', endpoint)).toBe('legacy')
    const edits = mcpEdits(snapshot(legacy), change, managed)
    expect(edits).toEqual([{ name: 'foreman-code', value: launcher }, { name: 'graphql-app', value: undefined }, { name: 'graphql-operator', value: undefined }])
    const after = applyMcpEdits(legacy, edits)
    expect(Object.keys(after).sort()).toEqual(['foreman-code', 'linear'])
    expect(managedStatus(snapshot(after), 'graphql', endpoint)).toBe('installed')
    // An installed entry with leftovers finishes the upgrade without rewriting its policies.
    const leftover = { graphql: { ...launcher, disabled_tools: ['context_get'] }, 'graphql-app': { enabled: true } }
    expect(managedStatus(snapshot(leftover), 'graphql', endpoint)).toBe('legacy')
    expect(applyMcpEdits(leftover, mcpEdits(snapshot(leftover), change, managed))).toEqual({ 'foreman-code': { ...launcher, disabled_tools: ['context_get'] } })
    // Legacy entries owned by another configuration layer are not user-file edits.
    expect(() => mcpEdits({ ...snapshot(legacy), ownership: { 'graphql-app': false } }, change, managed)).toThrow('inherited')
  })
  it('refuses custom or inherited connections instead of overwriting them', () => {
    for (const url of ['https://example.com/mcp', 'http://127.0.0.1:3012/custom']) {
      const existing = nativeConnection({ transport: 'remote', url, bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN' })
      expect(() => replacement(snapshot({ graphql: existing }), change, managed)).toThrow('custom')
    }
    const inherited = { ...snapshot({ graphql: launcher }), ownership: { graphql: false } }
    expect(managedStatus(inherited, 'graphql', endpoint)).toBe('inherited')
    expect(() => replacement(inherited, change, managed)).toThrow('already has')
  })
})
