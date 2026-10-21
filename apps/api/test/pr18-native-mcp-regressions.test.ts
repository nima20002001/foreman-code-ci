import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { describe, expect, it } from 'vitest'
import { assertChange, assertManagedChange, fingerprint, LINEAR_MCP_ENDPOINT, managedChange, managedEnableChange, managedStatus,
  nativeConnection, publicMcpList, replacement, userOwnsMcpEntry, type NativeMcpSnapshot } from '../src/modules/harnesses/nativeMcpCommon.js'
import { codexMcpOwnership } from '../src/modules/harnesses/codexMcpConnections.js'
import { NativeMcpNotSubmittedError, withNativeMcpDelivery } from '../src/modules/harnesses/nativeMcpDelivery.js'

const endpoint = 'http://127.0.0.1:3000/mcp'
function snapshot(harness: NativeMcpSnapshot['harness'], name = 'graphql', url = endpoint): NativeMcpSnapshot {
  const entry = harness === 'codex' ? { url, enabled: true, bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' }
    : { type: 'remote', url, enabled: true, oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_MCP_TOKEN}' } }
  return { harness, revision: fingerprint(entry), user: { [name]: entry }, effective: { [name]: structuredClone(entry) },
    userConfig: {}, version: '1', file: '/private/native-config', }
}

describe('PR18 native MCP policy and provenance', () => {
  it('treats Codex native null bearer metadata as the absent user-file value', () => {
    const current = snapshot('codex', 'linear_trial', LINEAR_MCP_ENDPOINT)
    current.user.linear_trial = { url: LINEAR_MCP_ENDPOINT, enabled: true }
    current.effective.linear_trial = { type: 'streamable_http', url: LINEAR_MCP_ENDPOINT, enabled: true,
      bearer_token_env_var: null, http_headers: {}, env_http_headers: {}, http_headers_helper: null, disabled_reason: null }
    expect(userOwnsMcpEntry(current, 'linear_trial')).toBe(true)
    expect(publicMcpList(current).servers[0]).toMatchObject({ origin: 'user', editable: true })
  })
  it.each(['codex'] as const)('repairs fixed-endpoint and disabled %s entries without dropping any restriction', (harness) => {
    for (const enabled of [true, false]) {
      const current = snapshot(harness, 'graphql', enabled ? 'http://127.0.0.1:9999/mcp' : endpoint)
      const policy = { enabled_tools: ['read'], disabled_tools: ['write'], default_tools_approval_mode: 'prompt',
        tools: { delete: { approval_mode: 'prompt', enabled: false } } }
      const entry = { ...current.user['graphql'] as object, enabled, ...policy }
      current.user['graphql'] = entry; current.effective['graphql'] = structuredClone(entry)
      // A fixed endpoint cannot follow the owning app; repair converts it to the launcher and keeps enablement.
      expect(managedStatus(current, 'graphql', endpoint)).toBe('mismatch')
      expect(() => replacement(current, managedEnableChange('graphql', true), { preset: 'graphql', endpoint })).toThrow('matching user-owned preset')
      const next = replacement(current, managedChange('graphql', true, endpoint), { preset: 'graphql', endpoint })
      expect(next).toEqual({ ...policy, ...nativeConnection(appLauncherConnection()), enabled })
      expect(next).toMatchObject(policy)
    }
  })
  it.each(['codex'] as const)('rejects customized %s credentials rather than replacing their policies', (harness) => {
    const current = snapshot(harness)
    const entry = harness === 'codex' ? { url: endpoint, bearer_token_env_var: 'OTHER_TOKEN' }
      : { type: 'remote', url: endpoint, oauth: false, headers: { Authorization: 'Bearer {env:OTHER_TOKEN}' } }
    current.user['graphql'] = entry; current.effective['graphql'] = entry
    expect(() => replacement(current, managedChange('graphql', true, endpoint), { preset: 'graphql', endpoint })).toThrow()
  })
  it.each(['codex'] as const)('requires explicit conversion of a full-access %s Linear endpoint', (harness) => {
    const current = snapshot(harness, 'linear', 'https://mcp.linear.app/mcp')
    const entry = harness === 'codex' ? { url: 'https://mcp.linear.app/mcp', enabled: true, bearer_token_env_var: 'LINEAR_TOKEN', disabled_tools: ['delete'] }
      : { type: 'remote', url: 'https://mcp.linear.app/mcp', enabled: true, oauth: { scope: 'read write' } }
    current.user.linear = entry; current.effective.linear = structuredClone(entry)
    expect(managedStatus(current, 'linear', endpoint)).toBe('mismatch')
    const converted = replacement(current, managedChange('linear', true, endpoint), { preset: 'linear', endpoint })!
    expect(converted).toEqual({ ...entry, url: LINEAR_MCP_ENDPOINT, enabled: true })
    current.user.linear = converted; current.effective.linear = converted
    expect(managedStatus(current, 'linear', endpoint)).toBe('installed')
    expect(() => assertManagedChange(current, managedChange('linear', false, endpoint), 'linear', endpoint)).not.toThrow()
  })
  it.each(['codex'] as const)('refuses protected Linear removal through both %s paths', (harness) => {
    const current = snapshot(harness, 'linear', LINEAR_MCP_ENDPOINT)
    const entry = harness === 'codex' ? { url: LINEAR_MCP_ENDPOINT, bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' }
      : { type: 'remote', url: LINEAR_MCP_ENDPOINT, oauth: false, headers: { Authorization: 'Bearer {env:GRAPHQL_MCP_TOKEN}' } }
    current.user.linear = entry; current.effective.linear = entry
    expect(publicMcpList(current).servers[0]?.protected).toBe(true)
    expect(managedStatus(current, 'linear', endpoint)).not.toBe('installed')
    expect(() => assertChange(current, { kind: 'remove', name: 'linear' })).toThrow()
    expect(() => assertManagedChange(current, managedChange('linear', false, endpoint), 'linear', endpoint)).toThrow()
  })
  it.each(['codex'] as const)('detects same-URL %s transport, enable and ownership overrides', (harness) => {
    for (const change of [{ enabled: false }, { type: 'local', command: ['/untrusted'] }]) {
      const current = snapshot(harness)
      current.effective['graphql'] = { ...current.effective['graphql'] as object, ...change }
      expect(managedStatus(current, 'graphql', endpoint)).toBe('inherited')
      expect(publicMcpList(current).servers[0]?.origin).toBe('inherited')
      expect(() => assertManagedChange(current, managedChange('graphql', false, endpoint), 'graphql', endpoint)).toThrow()
    }
    const current = snapshot(harness)
    current.ownership = { 'graphql': false }
    expect(managedStatus(current, 'graphql', endpoint)).toBe('inherited')
  })
  it('does not classify a same-URL Codex credential override as installed', () => {
    const current = snapshot('codex')
    current.effective['graphql'] = { url: endpoint, type: 'streamable_http', enabled: true, bearer_token_env_var: 'OTHER_TOKEN' }
    expect(managedStatus(current, 'graphql', endpoint)).toBe('inherited')
  })

  it('detects identical Codex entries with a second configuration source', () => {
    const current = snapshot('codex')
    const user = { name: { type: 'user' }, config: { mcp_servers: current.user } }
    const project = { name: { type: 'project' }, config: { mcp_servers: current.user } }
    expect(codexMcpOwnership([project, user], user, current.user)['graphql']).toBe(false)
    expect(codexMcpOwnership([{ ...project, disabledReason: 'untrusted' }, user], user, current.user)['graphql']).toBe(true)
  })
  it('provides explicit no-delivery evidence for an abort before the native write', async () => {
    const controller = new AbortController(); controller.abort()
    let writes = 0
    await expect(withNativeMcpDelivery(async (writing) => { controller.signal.throwIfAborted(); writing(); writes++ }))
      .rejects.toBeInstanceOf(NativeMcpNotSubmittedError)
    expect(writes).toBe(0)
    const lost = new Error('Lost acknowledgement')
    await expect(withNativeMcpDelivery(async (writing) => { writing(); throw lost })).rejects.toBe(lost)
  })
})
