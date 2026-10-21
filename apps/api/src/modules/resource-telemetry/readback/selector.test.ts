import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { telemetryComputerFixture, telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import {
  TelemetrySelectorResultSchema, telemetrySelectorKey, type TelemetryOwner, type TelemetrySelector,
  type TelemetrySelectorTarget, type TrustedTelemetryContext,
} from '@foreman-code/contracts/resource-telemetry'
import { ResourceTelemetryService } from '../ingestion/service.js'
import { registerResourceTelemetrySelectorRoutes } from '../../../routes/resourceTelemetrySelector.js'
import { registerResourceTelemetrySelectorTools } from '../../../mcp/operator/resourceTelemetrySelector.js'
import {
  RESOURCE_TELEMETRY_SELECTOR_ROUTE, RESOURCE_TELEMETRY_SELECTOR_TOOL, ResourceTelemetrySelectors,
  type TelemetryOwnedTargetFacts, type TelemetryTargetAuthority,
} from './selector.js'
const principal: ManagementPrincipal = { id: 'operator', name: 'Reader', audience: 'operator', grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
const signal = () => new AbortController().signal
const computerTarget: TelemetrySelectorTarget = { schemaVersion: 1, scope: 'computer', mainId: telemetryComputerFixture.mainId, hostRef: telemetryComputerFixture.host.hostRef }
const workflowTarget: Extract<TelemetrySelectorTarget, { scope: 'owned' }> = { schemaVersion: 1, scope: 'owned', mainId: telemetryOwnedFixture.mainId,
  target: { kind: 'workflow-execution', workspaceId: 'workspace-1', workflowId: 'workflow-1', runId: 'run-1', nodeId: 'node-1', executionId: 'execution-1' } }
function setup(owner: TelemetryOwner = telemetryOwnedFixture.owner) {
  const selector: Extract<TelemetrySelector, { scope: 'owned' }> = { ...structuredClone(telemetryOwnedFixture), owner }
  const host: TelemetryOwnedTargetFacts['host'] = structuredClone(selector.host)
  Reflect.deleteProperty(host, 'collectorGeneration')
  let facts: TelemetryOwnedTargetFacts = { owner, host, attributionRef: selector.attributionRef, attributionRevision: selector.attributionRevision }
  let computerAllowed = true, sharedAllowed = true, active = true, sharedOwners: TelemetryOwner[] = []
  const allow = (p: ManagementPrincipal, scope: 'computer' | 'owned') => p.id === principal.id && (scope !== 'computer' || computerAllowed)
  const service = new ResourceTelemetryService({ clock: { monotonicMs: () => 0, unixMs: () => 1_000_000 },
    sessions: { active: async () => active, presence: async () => 'online' },
    ownership: { resolve: vi.fn(async candidate => telemetrySelectorKey(candidate) === telemetrySelectorKey(selector)
      ? { selector, state: 'active' as const, sharedOwners } : null) },
    reads: { allow: vi.fn(async (p, candidate) => allow(p, candidate.scope)), allowSharedOwner: async () => sharedAllowed } })
  const authority: TelemetryTargetAuthority = { allowTarget: vi.fn(async (p, target) => allow(p, target.scope)),
    resolveOwned: vi.fn(async () => ({ kind: 'owned' as const, facts: structuredClone(facts) })) }
  const h = telemetryComputerFixture.host
  const context: Extract<TrustedTelemetryContext, { kind: 'main-local' }> = { kind: 'main-local', mainId: telemetryComputerFixture.mainId,
    deviceId: h.deviceId, applicationInstallationId: h.applicationInstallationId, bootId: h.bootId, runtimeEpoch: h.runtimeEpoch, capability: 'resource-telemetry/v1' }
  return { service, authority, context, selector, selectors: new ResourceTelemetrySelectors(service, authority),
    facts(value: TelemetryOwnedTargetFacts) { facts = value }, getFacts: () => structuredClone(facts),
    computerAllowed(value: boolean) { computerAllowed = value }, active(value: boolean) { active = value },
    shared(value: TelemetryOwner[]) { sharedOwners = value; sharedAllowed = false } }
}
const roles: Array<{ owner: TelemetryOwner; target: Extract<TelemetrySelectorTarget, { scope: 'owned' }>['target'] }> = [
  { owner: telemetryOwnedFixture.owner, target: workflowTarget.target },
  { owner: { kind: 'ci-job', subject: { kind: 'manual-job', workspaceId: 'workspace-1', jobExecutionId: 'job-1', definitionId: 'definition-1' },
    executionId: 'job-1', attemptId: 'attempt-1', operationId: 'operation-1', bindingHash: 'a'.repeat(64), owner: { grantId: 'grant-1', epoch: '1' } },
    target: { kind: 'ci-job', workspaceId: 'workspace-1', jobExecutionId: 'job-1', attemptId: 'attempt-1' } },
  { owner: { kind: 'agent-conversation', workspaceId: 'workspace-1', workflowId: 'workflow-1', nodeId: 'node-1', agentId: 'agent-1', conversationId: 'conversation-1', leaseId: 'private-lease' },
    target: { kind: 'agent-conversation', workspaceId: 'workspace-1', workflowId: 'workflow-1', nodeId: 'node-1', agentId: 'agent-1', conversationId: 'conversation-1' } },
  { owner: { kind: 'operator-conversation', conversationId: 'conversation-1', leaseId: 'private-lease' }, target: { kind: 'operator-conversation', conversationId: 'conversation-1' } },
]
describe('authorized telemetry selector discovery', () => {
  it.each(roles)('resolves $target.kind before first sample without caller generation or grant facts', async ({ owner, target }) => {
    const s = setup(owner)
    await s.service.handshake(s.context, 'collector-1', signal())
    const result = TelemetrySelectorResultSchema.parse(await s.selectors.resolve(principal, { ...workflowTarget, target }, signal()))
    expect(result).toEqual({ kind: 'selector', selector: s.selector })
    expect((await s.service.read(principal, s.selector, signal())).kind).toBe('no-sample')
    await s.service.close()
  })
  it('denies before private owner lookup and separates computer policy from owned scope', async () => {
    const s = setup(); await s.service.handshake(s.context, 'collector-1', signal())
    const denied = { ...principal, id: 'denied' }
    expect(await s.selectors.resolve(denied, workflowTarget, signal())).toEqual({ kind: 'denied' })
    expect(s.authority.resolveOwned).not.toHaveBeenCalled()
    expect(s.service.ports.ownership.resolve).not.toHaveBeenCalled()
    s.computerAllowed(false)
    expect(await s.selectors.resolve(principal, computerTarget, signal())).toEqual({ kind: 'denied' })
    expect((await s.selectors.resolve(principal, workflowTarget, signal())).kind).toBe('selector')
    expect(await s.selectors.resolve({ ...principal, revokedAt: '2026-10-01T00:00:00Z' }, workflowTarget, signal())).toEqual({ kind: 'denied' })
    await s.service.close()
  })
  it('does not substitute a wrong execution, reboot, shared owner, or retired session', async () => {
    const s = setup(); await s.service.handshake(s.context, 'collector-1', signal())
    const original = s.getFacts()
    if (original.owner.kind !== 'workflow-execution') throw new Error('workflow owner')
    s.facts({ ...original, owner: { ...original.owner, executionId: 'other-execution' } })
    expect(await s.selectors.resolve(principal, workflowTarget, signal())).toEqual({ kind: 'unavailable' })
    s.facts({ ...original, host: { ...original.host, bootId: '99999999-9999-4999-8999-999999999999' } })
    expect(await s.selectors.resolve(principal, workflowTarget, signal())).toEqual({ kind: 'unavailable' })
    s.facts(original); s.shared([telemetryOwnedFixture.owner])
    expect(await s.selectors.resolve(principal, workflowTarget, signal())).toEqual({ kind: 'unavailable' })
    s.service.revoke(s.context)
    expect(await s.selectors.resolve(principal, computerTarget, signal())).toEqual({ kind: 'unavailable' })
    await s.service.close()
  })
  it('uses only the new authenticated collector generation and fences revocation during lookup', async () => {
    const s = setup(); await s.service.handshake(s.context, 'collector-1', signal())
    await s.service.handshake(s.context, 'collector-2', signal())
    const current = await s.selectors.resolve(principal, computerTarget, signal())
    expect(current.kind === 'selector' && current.selector.host.collectorGeneration).toBe('collector-2')
    s.authority.resolveOwned = async () => { s.service.revoke(s.context); return { kind: 'owned', facts: s.getFacts() } }
    expect(await s.selectors.resolve(principal, workflowTarget, signal())).toEqual({ kind: 'unavailable' })
    await s.service.close()
  })
  it('resolves only the actual W07 connection generation and preserves worker installation identity', async () => {
    const s = setup()
    const context: Extract<TrustedTelemetryContext, { kind: 'remote' }> = { kind: 'remote', capability: 'resource-telemetry/v1', binding: {
      mainId: telemetryComputerFixture.mainId, deviceId: telemetryComputerFixture.host.deviceId, workerInstallationId: 'actual-worker-installation',
      bootId: telemetryComputerFixture.host.bootId, keyRevision: 2, authorizationRevision: 3, connectionGeneration: 4,
      connectionEpoch: '88888888-8888-4888-8888-888888888888' } }
    const first = await s.service.handshake(context, 'worker-collector-1', signal())
    const target: TelemetrySelectorTarget = { ...computerTarget, hostRef: first.host.hostRef }
    expect(await s.selectors.resolve(principal, target, signal())).toEqual({ kind: 'selector', selector: {
      schemaVersion: 1, scope: 'computer', mainId: first.mainId, host: first.host } })
    const nextContext = { ...context, binding: { ...context.binding, connectionGeneration: 5, connectionEpoch: '99999999-9999-4999-8999-999999999999' } }
    const next = await s.service.handshake(nextContext, 'worker-collector-2', signal())
    const current = await s.selectors.resolve(principal, target, signal())
    expect(current.kind === 'selector' && current.selector.host).toEqual(next.host)
    expect(next.host.applicationInstallationId).toBe(context.binding.workerInstallationId)
    expect(next.host.connectionGeneration).toBe(5)
    const old = { schemaVersion: 1 as const, scope: 'computer' as const, mainId: first.mainId, host: first.host }
    expect((await s.service.read(principal, old, signal())).kind).toBe('no-sample')
    await s.service.close()
  })
  it('rechecks the public target grant after resolving its private facts', async () => {
    const s = setup(); await s.service.handshake(s.context, 'collector-1', signal())
    let checks = 0
    s.authority.allowTarget = async () => ++checks === 1
    expect(await s.selectors.resolve(principal, workflowTarget, signal())).toEqual({ kind: 'denied' })
    expect(checks).toBe(2)
    await s.service.close()
  })
  it('rejects live session denial before returning an identity', async () => {
    const s = setup(); await s.service.handshake(s.context, 'collector-1', signal()); s.active(false)
    expect(await s.selectors.resolve(principal, computerTarget, signal())).toEqual({ kind: 'denied' })
    await s.service.close()
  })
  it('has authenticated HTTP/MCP parity for first selectors, denial and unavailable results', async () => {
    const s = setup(); await s.service.handshake(s.context, 'collector-1', signal())
    const audit: string[] = []
    const denialAudit = { record: async (id: string, source: 'http' | 'mcp') => { audit.push(`${source}:${id}`) } }
    const app = Fastify()
    app.addHook('onRequest', async (request, reply) => {
      const bearer = request.headers.authorization
      if (bearer !== 'Bearer authorized' && bearer !== 'Bearer denied') return reply.code(401).send({ error: 'AUTH_REQUIRED' })
      request.operatorPrincipal = bearer === 'Bearer authorized' ? principal : { ...principal, id: 'denied' }
    })
    registerResourceTelemetrySelectorRoutes(app, s.selectors, denialAudit)
    app.post('/mcp', async (request, reply) => {
      const server = new McpServer({ name: 'telemetry-selector-test', version: '1.0.0' })
      registerResourceTelemetrySelectorTools(server, request.operatorPrincipal!, s.selectors, denialAudit)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      reply.raw.on('close', () => { void transport.close(); void server.close() })
      await server.connect(transport); reply.hijack(); await transport.handleRequest(request.raw, reply.raw, request.body)
    })
    try {
      for (const target of [computerTarget, workflowTarget]) for (const credential of ['authorized', 'denied']) {
        const http = await app.inject({ method: 'POST', url: RESOURCE_TELEMETRY_SELECTOR_ROUTE, headers: { authorization: `Bearer ${credential}` }, payload: target })
        const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${credential}`,
          accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: RESOURCE_TELEMETRY_SELECTOR_TOOL, arguments: target } } })
        const result = mcp.json().result
        expect(decodeMcpToolResult(result)).toEqual(http.json())
        const read = TelemetrySelectorResultSchema.parse(http.json())
        if (credential === 'denied') {
          expect(http.statusCode).toBe(403); expect(result.isError).toBe(true); expect(read).toEqual({ kind: 'denied' })
        } else {
          expect(http.statusCode).toBe(200); expect(read.kind).toBe('selector')
          expect(read.kind === 'selector' && read.selector.host.collectorGeneration).toBe('collector-1')
        }
      }
      s.service.revoke(s.context)
      const unavailable = await app.inject({ method: 'POST', url: RESOURCE_TELEMETRY_SELECTOR_ROUTE, headers: { authorization: 'Bearer authorized' }, payload: computerTarget })
      expect(unavailable.json()).toEqual({ kind: 'unavailable' })
      const invalid = await app.inject({ method: 'POST', url: RESOURCE_TELEMETRY_SELECTOR_ROUTE, headers: { authorization: 'Bearer authorized' }, payload: { ...computerTarget, collectorGeneration: 'invented' } })
      expect(invalid.statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url: RESOURCE_TELEMETRY_SELECTOR_ROUTE, payload: computerTarget })).statusCode).toBe(401)
      expect(audit.sort()).toEqual(['http:denied', 'http:denied', 'mcp:denied', 'mcp:denied'])
    } finally { await app.close(); await s.service.close() }
  })
})
