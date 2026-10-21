import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ReadStream } from 'node:fs'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { FileWithRevision } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { PostgresAccessService } from '../../modules/access/postgres.js'
import { DomainError } from '../../modules/errors.js'
import { AgentReferenceService } from '../../modules/files/references/agentService.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.restoreAllMocks() })

it.each(['decorator', 'services'] as const)('delivers inherited references through %s with scoped reads and no write tools', async registration => {
  const principal: ManagementPrincipal = { id: 'worker', name: 'Worker', audience: 'worker', agentId: 'agent',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] }
  const content = Buffer.from('permanent design reference')
  const createdAt = '2026-10-01T00:00:00.000Z'
  const row: FileWithRevision = { file: { fileId: 'reference', currentRevisionId: 'revision',
    scope: { kind: 'workspace_reference', workspaceId: 'workspace' }, state: 'ready', createdAt },
  revision: { fileId: 'reference', revisionId: 'revision', filename: 'design.md', mediaType: 'text/markdown',
    byteSize: content.length, sha256: createHash('sha256').update(content).digest('hex'), origin: 'upload', createdAt } }
  let allowed = true
  const facts: unknown[] = []
  const references = new AgentReferenceService({
    authorization: { resolve: async (caller, subject) => {
      if (!allowed || caller.id !== principal.id || subject.kind !== 'execution') {
        throw new DomainError('FILE_REFERENCE_ACCESS_DENIED', 'Execution unavailable.', 403)
      }
      return { workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent', runId: 'run', executionId: 'execution' }
    } },
    files: { list: async scope => ({ items: scope.kind === 'workspace_reference' ? [row] : [],
      pageInfo: { nextCursor: null } }),
    read: async fileId => fileId === row.file.fileId ? { value: row, storageKey: 'object', ownerPrincipalId: 'owner' } : undefined },
    bytes: { download: async () => Readable.from([content]) as ReadStream },
    reads: { pinned: async () => new Map(), complete: async (context, ref, _at, authorize) => {
      await authorize({} as never)
      facts.push({ context, ref })
      return 'ready'
    } },
  })
  const access = new PostgresAccessService({} as never)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token !== 'execution-token') throw new DomainError('AUTH_REQUIRED', 'Invalid caller.', 401)
    return principal
  })
  let tools = ['files.references_list', 'files.reference_read']
  const interactions = { toolAccess: async () => ({ role: 'coder', tools }),
    canRead: async () => false, canRespond: async () => false } as unknown as AppInteractionService
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    appMcp: { access, interactions, ...(registration === 'services' ? { references } : {}) } })
  if (registration === 'decorator') app.decorate('agentReferenceService', references)
  const origin = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'execution-references', version: '1' })
  cleanups.push(async () => { await client.close(); await app.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin),
    { requestInit: { headers: { authorization: 'Bearer execution-token' } } }))
  const names = (await client.listTools()).tools.map(tool => tool.name)
  expect(names).toEqual(expect.arrayContaining(tools))
  expect(names).not.toContain('reference_file_add')
  for (const tool of (await client.listTools()).tools) expect(tool.annotations?.readOnlyHint).toBe(true)
  const list = await client.callTool({ name: 'files.references_list', arguments: {} })
  expect(list.structuredContent).toMatchObject({ items: [{ fileId: 'reference', revisionId: 'revision' }] })
  const read = { fileId: 'reference', revisionId: 'revision', offset: 0, length: 64 }
  expect((await client.callTool({ name: 'files.reference_read', arguments: read })).structuredContent)
    .toMatchObject({ status: 'ready', contentBase64: content.toString('base64') })
  expect(facts).toEqual([{ context: { workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent',
    runId: 'run', executionId: 'execution' }, ref: { fileId: 'reference', revisionId: 'revision' } }])
  expect((await client.callTool({ name: 'files.reference_read', arguments: { ...read, fileId: 'other-workspace' } })).structuredContent)
    .toMatchObject({ status: 'unavailable', reason: 'not_found' })
  allowed = false
  expect((await client.callTool({ name: 'files.reference_read', arguments: read })).isError).toBe(true)
  tools = ['context_get']
  expect((await client.callTool({ name: 'files.reference_read', arguments: read })).isError).toBe(true)
  expect((await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: 'Bearer invalid' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode).toBe(401)
})
