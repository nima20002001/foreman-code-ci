import { describe, expect, it } from 'vitest'
import { McpDetectionService, type NativeMcpInspectionEvidence } from './mcpDetection.js'
import { randomUUID } from 'node:crypto'

const endpoint = 'http://127.0.0.1:3000/mcp'
const input = { harness: 'claude' as const, runnerId: 'runner', workingDirectory: '/workspace' }
function evidence(): NativeMcpInspectionEvidence {
  return { ...input, providerVersion: '1.2.3', inspectedAt: '2026-10-01T00:00:00.000Z',
    generation: 'query-generation', authorizationScope: 'current-scope',
    entry: { name: 'graphql', transport: 'streamable-http', endpoint, status: 'connected',
      credentialArrangement: { kind: 'scoped_http_header', acknowledgement: {
        source: 'sdk_set_mcp_servers', serverName: 'graphql', endpoint,
        generation: 'query-generation', authorizationScope: 'current-scope',
      } } } }
}
async function inspect(value: NativeMcpInspectionEvidence) {
  return new McpDetectionService({ inspect: async () => value }, endpoint, 'graphql').inspect(input)
}
describe('scoped MCP credential mechanism evidence', () => {
  it('accepts a paired worker relay only with its matching SDK acknowledgement and configured Main endpoint', async () => {
    const deviceId = randomUUID()
    const scoped = { ...input, runnerId: `device:${deviceId}` }
    const value = evidence()
    value.runnerId = scoped.runnerId
    const entry = value.entry!
    const arrangement = entry.credentialArrangement!
    if (arrangement.kind !== 'scoped_http_header') throw new Error('Header fixture required')
    entry.endpoint = 'http://127.0.0.1:40215/mcp'
    entry.pairedEndpoint = { mainId: randomUUID(), deviceId, configuredEndpoint: endpoint, nativeEndpoint: entry.endpoint }
    arrangement.acknowledgement.endpoint = entry.endpoint
    const inspect = () => new McpDetectionService({ inspect: async () => value }, endpoint).inspect(scoped)
    expect((await inspect()).detection).toMatchObject({ state: 'connected', endpointMatches: true,
      credentialArrangement: { kind: 'scoped_http_header' } })
    entry.pairedEndpoint.configuredEndpoint = `${endpoint}/foreign`
    expect((await inspect()).detection.state).toBe('misconfigured')
    entry.pairedEndpoint.configuredEndpoint = endpoint
    entry.pairedEndpoint.deviceId = randomUUID()
    expect((await inspect()).detection.state).toBe('misconfigured')
    entry.pairedEndpoint.deviceId = deviceId
    arrangement.acknowledgement.generation = 'another-query'
    expect((await inspect()).detection.state).toBe('misconfigured')
  })
  it('accepts the owned SDK header ACK only for current scope, generation, endpoint and health', async () => {
    const result = await inspect(evidence())
    expect(result.detection).toMatchObject({ state: 'connected', credentialEnvironmentVariable: null,
      credentialArrangement: { kind: 'scoped_http_header' } })
    expect(JSON.stringify(result)).not.toMatch(/current-scope|query-generation|sdk_set_mcp_servers/)
  })
  it.each(['scope', 'generation', 'endpoint', 'server', 'health', 'transport', 'missing-scope'] as const)('rejects header ACK with mismatched %s', async (fault) => {
    const value = evidence()
    const entry = value.entry!
    const arrangement = entry.credentialArrangement!
    if (arrangement.kind !== 'scoped_http_header') throw new Error('Expected header fixture')
    if (fault === 'scope') arrangement.acknowledgement.authorizationScope = 'previous-scope'
    if (fault === 'generation') arrangement.acknowledgement.generation = 'previous-query'
    if (fault === 'endpoint') arrangement.acknowledgement.endpoint = `${endpoint}/foreign`
    if (fault === 'server') arrangement.acknowledgement.serverName = 'foreign'
    if (fault === 'health') entry.status = 'authentication_required'
    if (fault === 'transport') entry.transport = 'sse'
    if (fault === 'missing-scope') delete value.authorizationScope
    expect((await inspect(value)).detection).toMatchObject({ state: 'misconfigured',
      credentialEnvironmentVariable: null, credentialArrangement: { kind: 'unknown' } })
  })
  it('does not turn an unknown static HTTP entry or explicit unknown into credential evidence', async () => {
    const value = evidence()
    value.entry!.credentialArrangement = { kind: 'unknown' }
    value.entry!.credentialEnvironmentVariable = 'GRAPHQL_MCP_TOKEN'
    expect((await inspect(value)).detection).toMatchObject({ state: 'misconfigured', credentialArrangement: { kind: 'unknown' } })
    delete value.entry!.credentialEnvironmentVariable
    delete value.entry!.credentialArrangement
    expect((await inspect(value)).detection).toMatchObject({ state: 'misconfigured', credentialArrangement: { kind: 'unknown' } })
  })
  it.each(['codex'] as const)('preserves legacy %s environment reference facts', async (harness) => {
    const value = evidence()
    value.harness = harness
    delete value.entry!.credentialArrangement
    value.entry!.credentialEnvironmentVariable = 'GRAPHQL_MCP_TOKEN'
    const result = await new McpDetectionService({ inspect: async () => value }, endpoint, 'graphql').inspect({ ...input, harness })
    expect(result.detection).toMatchObject({ state: 'connected', credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
      credentialArrangement: { kind: 'environment_variable', environmentVariable: 'GRAPHQL_MCP_TOKEN' } })
  })
})
