import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { telemetryComputerFixture, telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { TelemetryReadResultSchema, type TelemetryCollectedBatch, type TelemetryOwner, type TrustedTelemetryContext } from '@foreman-code/contracts/resource-telemetry'
import { ResourceTelemetryService } from './service.js'
import { registerResourceTelemetryRoutes } from '../../../routes/resourceTelemetry.js'
import { registerResourceTelemetryTools } from '../../../mcp/operator/resourceTelemetry.js'
import { RESOURCE_TELEMETRY_READ_ROUTE, RESOURCE_TELEMETRY_READ_TOOL } from '../readback/adapters.js'

const principal: ManagementPrincipal = { id: 'current', name: 'Reader', audience: 'operator', grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
const historicalOwner: TelemetryOwner = { kind: 'operator-conversation', conversationId: 'historical-co-owner', leaseId: 'historical-lease' }
const replacementOwner: TelemetryOwner = { kind: 'operator-conversation', conversationId: 'replacement-co-owner', leaseId: 'replacement-lease' }

it.each(['unshared-replacement', 'shared-replacement', 'no-replacement', 'incomplete-history'] as const)(
  'authorizes captured co-owners through authenticated HTTP and MCP after %s', async mode => {
    let mono = 0, complete = mode !== 'incomplete-history'
    const sharedOwners: TelemetryOwner[] = [historicalOwner]
    const service = new ResourceTelemetryService({ clock: { monotonicMs: () => mono, unixMs: () => 1000 + mono },
      sessions: { active: async () => true, presence: async () => 'online' },
      ownership: { resolve: async selector => ({ selector, state: 'active', sharedOwners, sharedOwnersComplete: complete }) },
      reads: { allow: async p => p.id !== 'denied', allowSharedOwner: async (p, owner) => p.id === 'historical'
        || owner.kind === 'operator-conversation' && owner.conversationId === replacementOwner.conversationId } })
    const h = telemetryComputerFixture.host
    const context: TrustedTelemetryContext = { kind: 'main-local', mainId: telemetryComputerFixture.mainId,
      deviceId: h.deviceId, applicationInstallationId: h.applicationInstallationId, bootId: h.bootId, runtimeEpoch: h.runtimeEpoch, capability: 'resource-telemetry/v1' }
    const signal = new AbortController().signal
    await service.handshake(context, 'collector-1', signal)
    const ingest = async (sequence: string, numeric: boolean) => {
      const challenge = (await service.challenge(context, signal))!
      const batch: TelemetryCollectedBatch = { schemaVersion: 1, identity: challenge.identity, challengeId: challenge.challengeId,
        sequence, collectedAtUnixMs: 1000 + mono, challengeReceivedMonoNs: '1', captureStartMonoNs: '1', captureEndMonoNs: '1001', logicalCpuCount: 8,
        host: null, owned: [{ selector: telemetryOwnedFixture, coverage: { boundary: 'partial', shared: sharedOwners.length > 0, reasons: [] },
          cpu: { state: 'unavailable', reason: 'source-failure' }, memory: numeric
            ? { state: 'ok', value: { kind: 'rss-sum', bytes: 4096, totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: true } }
            : { state: 'unavailable', reason: 'source-failure' } }], diagnostics: [], truncated: false }
      expect((await service.ingest(context, JSON.stringify(batch), signal)).status).toBe('accepted')
    }
    await ingest('1', true)
    if (complete) {
      const initial = await service.read({ ...principal, id: 'historical' }, telemetryOwnedFixture, signal)
      expect(initial.kind === 'sample' && initial.lastKnown?.memory.value?.bytes).toBe(4096)
    }
    // Mutate the live authority's array to prove the retained membership was captured by value.
    sharedOwners.splice(0, 1, ...(mode === 'shared-replacement' || mode === 'no-replacement' ? [replacementOwner] : []))
    complete = true; mono = 2000
    if (mode !== 'no-replacement') await ingest('2', false)

    const audits: string[] = [], audit = { record: async (id: string, source: 'http' | 'mcp') => { audits.push(`${source}:${id}`) } }
    const app = Fastify()
    app.addHook('onRequest', async (request, reply) => {
      const credential = request.headers.authorization?.replace('Bearer ', '')
      if (!['current', 'historical', 'denied'].includes(credential ?? '')) return reply.code(401).send({ error: 'AUTH_REQUIRED' })
      request.operatorPrincipal = { ...principal, id: credential! }
    })
    registerResourceTelemetryRoutes(app, service, audit)
    app.post('/mcp', async (request, reply) => {
      const server = new McpServer({ name: 'historical-telemetry-regression', version: '1.0.0' })
      registerResourceTelemetryTools(server, request.operatorPrincipal!, service, audit)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      reply.raw.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
    })
    try {
      for (const credential of ['current', 'historical', 'denied']) {
        const http = await app.inject({ method: 'POST', url: RESOURCE_TELEMETRY_READ_ROUTE, headers: { authorization: `Bearer ${credential}` }, payload: telemetryOwnedFixture })
        const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${credential}`,
          accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: RESOURCE_TELEMETRY_READ_TOOL, arguments: telemetryOwnedFixture } } })
        expect(decodeMcpToolResult(mcp.json().result)).toEqual(http.json())
        if (credential === 'denied') {
          expect(http.statusCode).toBe(403); expect(mcp.json().result.isError).toBe(true)
          expect(http.json().sample).toBeUndefined(); expect(http.json().lastKnown).toBeUndefined()
          continue
        }
        expect(http.statusCode).toBe(200)
        const read = TelemetryReadResultSchema.parse(http.json())
        if (mode === 'no-replacement' && credential === 'current') {
          expect(read).toMatchObject({ kind: 'no-sample', reason: 'shared-restricted' })
          expect(JSON.stringify(read)).not.toContain('4096')
          continue
        }
        if (read.kind !== 'sample') throw new Error('sample')
        if (credential === 'historical' && mode !== 'incomplete-history') {
          expect(read.lastKnown?.memory.value?.bytes).toBe(4096)
          expect(read.lastKnown?.sequence).toBe('1')
        } else {
          expect(read.lastKnown).toBeNull()
          expect(JSON.stringify(read)).not.toContain('4096')
        }
        if (mode !== 'no-replacement') expect(read.sample.memory).toMatchObject({ state: 'unavailable', value: null })
      }
      expect(audits.sort()).toEqual(['http:denied', 'mcp:denied'])
      expect((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode).toBe(401)
    } finally { await app.close(); await service.close() }
  })
