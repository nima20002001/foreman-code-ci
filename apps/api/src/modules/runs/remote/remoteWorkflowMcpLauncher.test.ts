import { createHash } from 'node:crypto'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildApp } from '../../../app.js'
import { PostgresAccessService } from '../../access/postgres.js'
import type { AppInteractionService } from '../../interactions/app.js'
import { DomainError } from '../../errors.js'
import { directory, runningInstalledFixture } from './__tests__/installedWorkflowHost.js'

afterEach(() => vi.unstubAllEnvs())

it('blocks the remote Codex session when its launcher route cannot be registered', async () => {
  const root = await directory()
  const parent = join(root, 'occupied')
  const contents = 'occupied launcher directory'
  await writeFile(parent, contents)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', parent)
  const onSessionStart = vi.fn(async () => {})
  const request = vi.fn(async () => { throw new Error('Unregistered session cannot call MCP') })
  await expect(runningInstalledFixture('generation', { mcp: {
    request, onSessionStart,
  } })).rejects.toMatchObject({ code: 'EEXIST', syscall: 'mkdir', path: parent })
  expect(onSessionStart).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
  expect(await readFile(parent, 'utf8')).toBe(contents)
})

it('registers the native launcher route before remote Codex startup and renews it inside the renewal window', async () => {
  const root = await directory()
  const launcher = join(root, 'launcher.mjs')
  await copyFile(new URL('../../../../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
  vi.stubEnv('FOREMAN_CODE_APP_MCP_DIRECTORY', root)
  const principal: ManagementPrincipal = { id: 'original-principal', name: 'Worker', audience: 'worker',
    agentId: 'agent', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), revokedAt: null,
    grants: [{ actions: ['interactions:read'], scope: {
      workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'],
    } }] }
  const context = { principal: { id: principal.id, audience: 'worker', agentId: principal.agentId,
    expiresAt: principal.expiresAt }, role: 'coder', tools: ['context_get'],
    scope: principal.grants[0]!.scope, capabilities: { contextGet: true, bugReport: false,
      interactionList: false, interactionGet: false, interactionRespond: false } }
  const denied = async () => { throw new DomainError('APP_ACCESS_DENIED', 'Access denied.', 403) }
  const interactions: AppInteractionService = { context: async () => structuredClone(context),
    canRead: async () => false, canRespond: async () => false,
    toolAccess: async () => ({ role: 'coder', tools: ['context_get'] }),
    list: denied, get: denied, respond: denied }
  const access = new PostgresAccessService({} as pg.Pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token !== 'original-token') throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return principal
  })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: { access, interactions } })
  const client = new Client({ name: 'remote-codex-session', version: '1' })
  let fixture: Awaited<ReturnType<typeof runningInstalledFixture>> | undefined
  try {
    // Hono's request draining requires real sockets rather than app.inject() sockets.
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    // Native provider and Main lease authorization are doubles; startup, launcher and MCP transport are real.
    fixture = await runningInstalledFixture('generation', { mcp: {
      request: async (body, protocolVersion) => {
        const reply = await fetch(new URL('/mcp', address), { method: 'POST', body: JSON.stringify(body),
          headers: { authorization: 'Bearer original-token', 'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}) } })
        const contentType = reply.headers.get('content-type')
        const responseBody = await reply.text()
        let transportType: 'empty' | 'text/event-stream' | 'application/json' = 'application/json'
        if (!responseBody) transportType = 'empty'
        else if (String(contentType).startsWith('text/event-stream')) transportType = 'text/event-stream'
        return { statusCode: reply.status, body: responseBody,
          contentType: transportType }
      },
      onSessionStart: async start => {
        expect(start.environment?.agentId).toBe('agent')
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher],
          env: { ...start.environment!.variables }, stderr: 'pipe' }))
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('context_get')
        const result = await client.callTool({ name: 'context_get', arguments: {} })
        expect(result.isError).not.toBe(true)
        expect(result.structuredContent).toEqual(context)
      },
    } })
    const routeKey = createHash('sha256').update('original-token').digest('hex')
    const routePath = join(root, 'routes', `${routeKey}.json`)
    const originalRoute = JSON.parse(await readFile(routePath, 'utf8'))
    const renewedExpiry = new Date(Date.now() + 45 * 60_000).toISOString()
    fixture.renew(renewedExpiry)
    await fixture.call('status')
    expect(JSON.parse(await readFile(routePath, 'utf8'))).toEqual(originalRoute)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(originalRoute.expiresAt) - 2 * 60_000)
    try {
      await fixture.call('status')
      const persistedRoute = JSON.parse(await readFile(routePath, 'utf8'))
      expect(persistedRoute.expiresAt).toBe(renewedExpiry)
      expect(persistedRoute.endpoint).toBe(originalRoute.endpoint)
      clock.mockReturnValue(Date.parse(originalRoute.expiresAt) + 5 * 60_000)
      const result = await client.callTool({ name: 'context_get', arguments: {} })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toEqual(context)
    } finally { clock.mockRestore() }
    const invalid = await fetch(new URL('/mcp', address), { method: 'POST',
      headers: { authorization: 'Bearer foreign-caller', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(invalid.status).toBe(401)
    await invalid.text()
    fixture.denyMcp()
    await expect(client.callTool({ name: 'context_get', arguments: {} })).rejects.toThrow()
  } finally {
    await client.close()
    if (fixture) {
      fixture.finish('succeeded')
      await fixture.settled
      await fixture.host.close()
    }
    await app.close()
  }
}, 15_000)
