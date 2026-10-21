import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { describe, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { telemetryComputerFixture, telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { TelemetryReadResultSchema, TelemetryReasonSchema, type TelemetryCollectedBatch, type TrustedTelemetryContext, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { ResourceTelemetryService } from '../ingestion/service.js'
import { registerResourceTelemetryRoutes } from '../../../routes/resourceTelemetry.js'
import { registerResourceTelemetryTools } from '../../../mcp/operator/resourceTelemetry.js'
import { RESOURCE_TELEMETRY_READ_ROUTE, RESOURCE_TELEMETRY_READ_TOOL } from './adapters.js'
const principal: ManagementPrincipal = { id: 'operator', name: 'Reader', audience: 'operator', grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
describe('authenticated HTTP/Operator MCP ResourceTelemetry parity', () => {
  it.each(['ordinary', 'fractional-monotonic', 'truncated-full-coverage', 'namespace-restricted', 'ended-expired'] as const)('reads retained %s samples identically and rejects denied and unauthenticated callers without private data', async mode => {
    let mono = 0
    const service = new ResourceTelemetryService({ clock: { monotonicMs: () => mono, unixMs: () => 1000 },
      sessions: { active: async () => true, presence: async () => 'online' },
      ownership: { resolve: async selector => ({ selector, state: mode === 'ended-expired' ? 'ended' : 'active', sharedOwners: [] }) },
      reads: { allow: async p => p.id === 'operator', allowSharedOwner: async () => false } })
    const h = telemetryComputerFixture.host
    const context: TrustedTelemetryContext = { kind: 'main-local', mainId: telemetryComputerFixture.mainId,
      deviceId: h.deviceId, applicationInstallationId: h.applicationInstallationId, bootId: h.bootId, runtimeEpoch: h.runtimeEpoch, capability: 'resource-telemetry/v1' }
    const signal = new AbortController().signal
    await service.handshake(context, 'collector-1', signal)
    const challenge = (await service.challenge(context, signal))!
    const row = (selector: TelemetrySelector): TelemetryCollectedBatch['owned'][number] => mode === 'namespace-restricted' && selector.scope === 'computer'
      ? { selector, coverage: { boundary: 'partial', shared: false, reasons: ['namespace-restricted'] },
        cpu: { state: 'unavailable', reason: 'namespace-restricted' }, memory: { state: 'unavailable', reason: 'namespace-restricted' } }
      : mode === 'ended-expired' && selector.scope === 'owned'
      ? { selector, coverage: { boundary: 'partial', shared: false, reasons: [] },
        cpu: { state: 'unavailable', reason: 'ended' }, memory: { state: 'unavailable', reason: 'ended' } }
      : ({ selector,
      coverage: { boundary: 'partial', shared: false, reasons: mode === 'truncated-full-coverage' ? TelemetryReasonSchema.options.filter(reason => reason !== 'limit').slice(0, 16) : ['process-tree-partial'] }, cpu: { state: 'warmup', reason: 'warmup' },
      memory: { state: 'ok', value: selector.scope === 'computer'
        ? { kind: 'host-used-estimate', bytes: 0, totalBytes: 8192, availableBytes: 8192, sharedPagesMayDoubleCount: false }
        : { kind: 'rss-sum', bytes: 4096, totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: true } },
      ...(selector.scope === 'computer' ? { storage: { totalBytes: 1000, availableBytes: 250 } } : {}) })
    if (mode === 'fractional-monotonic') mono = Number(123456n) / 1_000_000
    await service.ingest(context, JSON.stringify({ schemaVersion: 1, identity: challenge.identity,
      challengeId: challenge.challengeId, sequence: '1', collectedAtUnixMs: 1000,
      challengeReceivedMonoNs: '0', captureStartMonoNs: '0', captureEndMonoNs: '1000', logicalCpuCount: 8,
      host: row(telemetryComputerFixture), owned: [row(telemetryOwnedFixture)], diagnostics: [], truncated: mode === 'truncated-full-coverage' } satisfies TelemetryCollectedBatch), signal)
    if (mode === 'fractional-monotonic') mono += 0.5
    if (mode === 'ended-expired') mono = 900_000
    const audit: string[] = []
    const denialAudit = { record: async (id: string, source: 'http' | 'mcp') => { audit.push(`${source}:${id}`) } }
    const app = Fastify()
    app.addHook('onRequest', async (request, reply) => {
      const bearer = request.headers.authorization
      if (bearer !== 'Bearer authorized' && bearer !== 'Bearer denied') return reply.code(401).send({ error: 'AUTH_REQUIRED' })
      request.operatorPrincipal = bearer === 'Bearer authorized' ? principal : { ...principal, id: 'denied' }
    })
    registerResourceTelemetryRoutes(app, service, denialAudit)
    // Existing stateless authenticated application-MCP transport pattern; no production composition or DB.
    app.post('/mcp', async (request, reply) => {
      const server = new McpServer({ name: 'telemetry-contract-test', version: '1.0.0' })
      registerResourceTelemetryTools(server, request.operatorPrincipal!, service, denialAudit)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      reply.raw.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport); reply.hijack()
      await transport.handleRequest(request.raw, reply.raw, request.body)
    })
    try {
      for (const selector of [telemetryComputerFixture, telemetryOwnedFixture]) {
        for (const credential of ['authorized', 'denied']) {
          const http = await app.inject({ method: 'POST', url: RESOURCE_TELEMETRY_READ_ROUTE, headers: { authorization: `Bearer ${credential}` }, payload: selector })
          const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${credential}`,
            accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: RESOURCE_TELEMETRY_READ_TOOL, arguments: selector } } })
          const result = mcp.json().result
          expect(result).toBeDefined()
          expect(decodeMcpToolResult(result)).toEqual(http.json())
          if (credential === 'denied') { expect(http.statusCode).toBe(403); expect(result.isError).toBe(true); expect(http.json().lastKnown).toBeUndefined() }
          else {
            expect(http.statusCode).toBe(200)
            const read = TelemetryReadResultSchema.parse(http.json())
            if (mode === 'ended-expired') {
              expect(read.kind === 'no-sample' && read.reason).toBe(selector.scope === 'owned' ? 'ended' : 'stale')
              expect(http.json().lastKnown).toBeUndefined()
              continue
            }
            if (read.kind !== 'sample') throw new Error('sample')
            expect(read.sample.selector).toEqual(selector)
            if (mode === 'namespace-restricted' && selector.scope === 'computer') {
              expect(read.lastKnown).toBeNull()
              expect(read.sample.memory).toMatchObject({ state: 'unavailable', reason: 'namespace-restricted', value: null })
              expect(read.sample.cpu).toMatchObject({ state: 'unavailable', reason: 'namespace-restricted', value: null })
              continue
            }
            expect(read.lastKnown!.memory.value).toEqual(read.sample.memory.value)
            expect(read.sample.storage).toEqual(selector.scope === 'computer' ? { totalBytes: 1000, availableBytes: 250 } : undefined)
            if (mode === 'fractional-monotonic') {
              expect(read.sample.freshUntilUnixMs).toBe(6999)
              expect(read.lastKnown!.freshUntilUnixMs).toBe(6999)
              expect(read.sample.ageUpperBoundMs).toBe(Number(123456n) / 1_000_000 + 0.5)
            }
            if (mode === 'truncated-full-coverage') for (const sample of [read.sample, read.lastKnown!]) {
              expect(sample.coverage.boundary).toBe('partial')
              expect(sample.coverage.reasons).toHaveLength(16)
              expect(sample.coverage.reasons).toContain('limit')
            }
          }
        }
      }
      expect(audit.sort()).toEqual(['http:denied', 'http:denied', 'mcp:denied', 'mcp:denied'])
      expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(401)
    } finally { await app.close(); await service.close() }
  })
})
