import { describe, expect, it } from 'vitest'
import { assertClaudeCredentialEndpoint, claudeMcpDetection, decodeClaudeMcpControl } from './mcpInspection.js'
import type { NativeMcpEntryEvidence } from '../mcpDetection.js'
const now = '2026-10-01T00:00:00.000Z'
describe('actual SDK MCP control evidence', () => {
  it('permits credential delivery to the observed app endpoint after token-free OAuth failure', () => {
    const endpoint = 'http://127.0.0.1:3041/mcp'
    const entry: NativeMcpEntryEvidence = { name: 'foreman-code', transport: 'streamable-http',
      endpoint, enabled: true, status: 'broken' }
    expect(() => assertClaudeCredentialEndpoint(entry, endpoint)).not.toThrow()
    const snapshot = decodeClaudeMcpControl([{ name: entry.name, status: 'failed',
      config: { type: 'http', url: endpoint } }], 'generation', now)
    expect(claudeMcpDetection(snapshot, { serverName: entry.name, url: endpoint })).toMatchObject({
      state: 'broken', credentialArrangement: { kind: 'unknown' },
    })
    for (const changed of [undefined, { ...entry, name: 'foreign' }, { ...entry, endpoint: `${endpoint}/foreign` },
      { ...entry, enabled: false }, { ...entry, status: 'disabled' as const },
      { ...entry, transport: 'stdio' as const }]) {
      expect(() => assertClaudeCredentialEndpoint(changed, endpoint)).toThrow('accepted Foreman Code HTTP endpoint')
    }
  })
  it.each(['graphql', 'foreman-code'])('recognizes %s with both supported token references and binds HTTP receipts to the observed name', (serverName) => {
    for (const token of ['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN']) {
      const stdio = decodeClaudeMcpControl([{ name: serverName, status: 'connected', config: {
        type: 'stdio', env: { [token]: 'private-token' },
      } }], 'generation', now)
      expect(claudeMcpDetection(stdio, { serverName: 'foreman-code' })).toMatchObject({
        serverName, state: 'connected', credentialEnvironmentVariable: token,
      })
      expect(JSON.stringify(stdio)).not.toContain('private-token')
    }
    const endpoint = 'http://127.0.0.1:3000/mcp'
    const http = decodeClaudeMcpControl([{ name: serverName, status: 'connected', config: { type: 'http', url: endpoint } }],
      'generation', now, { currentAuthorizationScope: 'scope', httpCredentialAcknowledgement: {
        source: 'sdk_set_mcp_servers', serverName, endpoint, generation: 'generation', authorizationScope: 'scope',
      } })
    expect(claudeMcpDetection(http, { serverName: 'foreman-code', url: endpoint }).credentialArrangement)
      .toEqual({ kind: 'scoped_http_header' })
  })
  it('refuses two app entries instead of selecting a connection implicitly', () => {
    const snapshot = decodeClaudeMcpControl(['graphql', 'foreman-code'].map(name => ({
      name, status: 'connected', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp' },
    })), 'generation', now)
    expect(() => claudeMcpDetection(snapshot, { serverName: 'foreman-code' })).toThrow('collision')
  })
  it.each([['pending', 'status_unavailable'], ['failed', 'broken'], ['needs-auth', 'authentication_required'], ['disabled', 'disabled'], ['connected', 'connected']])('maps real status %s without saved-config health', (status, state) => {
    const snapshot = decodeClaudeMcpControl([{ name: 'graphql', status, source: 'dynamic', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp' } }], 'generation', now)
    expect(claudeMcpDetection(snapshot, { serverName: 'graphql', url: 'http://127.0.0.1:3000/mcp' }).state).toBe(state)
  })
  it('withholds credential values, token URLs and command arguments from public inspection', () => {
    const snapshot = decodeClaudeMcpControl([{ name: 'graphql', status: 'connected', source: 'dynamic', config: { type: 'stdio', command: '/local/node', args: ['--token', 'private-argument'], env: { GRAPHQL_MCP_TOKEN: 'private-environment' }, headers: { Authorization: 'private-header' } } },
      { name: 'other', status: 'connected', config: { type: 'http', url: 'http://user:password@host/mcp?token=private-url' } }], 'generation', now)
    expect(JSON.stringify(snapshot)).not.toMatch(/private-|password/)
    expect(snapshot.servers[0]?.configuration?.argumentCount).toBe(2)
    expect(claudeMcpDetection(snapshot, { serverName: 'graphql' }).credentialEnvironmentVariable).toBe('GRAPHQL_MCP_TOKEN')
    expect(snapshot.servers[1]?.configuration?.url).toBeUndefined()
  })
  it('rejects malformed/unbounded native status instead of labeling a saved entry connected', () => {
    expect(() => decodeClaudeMcpControl([{ name: 'graphql', status: 'future-status' }], 'g', now)).toThrow('malformed')
    expect(() => decodeClaudeMcpControl(Array.from({ length: 129 }, () => ({ name: 'graphql', status: 'connected' })), 'g', now)).toThrow('bounded')
    expect(claudeMcpDetection(decodeClaudeMcpControl([], 'g', now), { serverName: 'graphql' }).state).toBe('not_detected')
  })
  it('does not infer a managed header ACK from configured headers, source labels or tools', () => {
    const snapshot = decodeClaudeMcpControl([{ name: 'graphql', status: 'connected', source: 'dynamic',
      config: { type: 'http', url: 'http://127.0.0.1:3000/mcp', headers: { Authorization: 'private-header' }, env: { GRAPHQL_MCP_TOKEN: 'private-env' } },
      tools: [{ name: 'context_get' }] }], 'generation', now)
    expect(claudeMcpDetection(snapshot, { serverName: 'graphql', url: 'http://127.0.0.1:3000/mcp' })).toMatchObject({
      credentialEnvironmentVariable: null, credentialArrangement: { kind: 'unknown' },
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/private-header|private-env/)
  })
  it.each(['valid', 'scope', 'generation', 'endpoint', 'server', 'health', 'broken'] as const)('checks actual SDK header receipt context: %s', (fault) => {
    const endpoint = 'http://127.0.0.1:3000/mcp'
    const acknowledgement = { source: 'sdk_set_mcp_servers' as const, serverName: fault === 'server' ? 'foreign' : 'graphql',
      endpoint: fault === 'endpoint' ? `${endpoint}/foreign` : endpoint,
      generation: fault === 'generation' ? 'old-generation' : 'generation',
      authorizationScope: fault === 'scope' ? 'old-scope' : 'current-scope' }
    let status = 'connected'
    if (fault === 'health') status = 'needs-auth'
    if (fault === 'broken') status = 'failed'
    const snapshot = decodeClaudeMcpControl([{ name: 'graphql', status,
      config: { type: 'http', url: endpoint } }], 'generation', now,
    { httpCredentialAcknowledgement: acknowledgement, currentAuthorizationScope: 'current-scope' })
    const detection = claudeMcpDetection(snapshot, { serverName: 'graphql', url: endpoint })
    expect(detection.credentialArrangement).toEqual({ kind: fault === 'valid' ? 'scoped_http_header' : 'unknown' })
    expect(detection.credentialEnvironmentVariable).toBeNull()
    expect(JSON.stringify(detection)).not.toMatch(/current-scope|old-scope|sdk_set_mcp_servers/)
  })
})
