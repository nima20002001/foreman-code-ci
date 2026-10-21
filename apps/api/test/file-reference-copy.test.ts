import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { describe, it } from 'vitest'
import { AgentFileCreateWorkingCopyResultSchema, AgentFilePublishResultSchema,
  AgentFileWorkingCopyEditResultSchema, MAX_FILE_READ_BYTES, type PermanentFileScope } from '@foreman-code/contracts/files'
import { DomainError } from '../src/modules/errors.js'
import type { FileQuery } from '../src/modules/files/repository.js'
import type { FileByteStorage } from '../src/modules/files/storage.js'
import { AgentReferenceService } from '../src/modules/files/references/agentService.js'
import { effectiveReference } from '../src/modules/files/references/agentLineage.js'
import { agentFileReferenceResolver } from '../src/modules/files/tools/referenceResolver.js'
import { AgentFileToolService } from '../src/modules/files/tools/service.js'
import { FILE_TOOLS_MCP_PATH, registerFileToolsMcp } from '../src/modules/files/tools/mcp.js'
import { ALL_FILE_TOOL_NAMES } from '../src/modules/files/tools/types.js'
import { fileToolFixture } from './support/fileTools.js'

// Real authenticated Fastify/MCP endpoint, AgentReferenceService and production reference adapter.
// Only persistence, principal/conversation lookup and byte storage use the existing memory fixture.
describe('FIL-02 production reference adapter supports detached working copies', () => {
  const scopes: PermanentFileScope[] = [
    { kind: 'workspace_reference', workspaceId: 'workspace-a' },
    { kind: 'workflow_reference', workspaceId: 'workspace-a', workflowId: 'workflow-a' },
  ]
  for (const scope of scopes) {
    it(`copies all pinned ${scope.kind} bytes, edits/publishes through MCP, and leaves the reference unchanged`, async () => {
      const f = await fileToolFixture()
      const token = await f.issue({ allowedTools: [...ALL_FILE_TOOL_NAMES] })
      const original = '# reference\n' + 'x'.repeat(MAX_FILE_READ_BYTES + 17)
      const ref = await f.upload(original)
      const stored = f.repository.values.get(ref.fileId)!
      stored.value.file = { fileId: ref.fileId, currentRevisionId: ref.revisionId, scope,
        state: 'ready', createdAt: stored.value.file.createdAt }
      const before = structuredClone(stored)
      const pins = new Map<string, string>()
      const references = new AgentReferenceService({ files: f.repository,
        bytes: f.bytes as unknown as FileByteStorage, clock: f.clock,
        authorization: { resolve: async (principal, subject) => {
          if (principal.id !== f.principal.id || subject.kind !== 'conversation'
            || subject.conversationId !== f.scope.chat.conversationId) throw new DomainError('DENIED', 'Denied', 403)
          return { workspaceId: 'workspace-a', workflowId: 'workflow-a', agentId: 'agent-a',
            conversationId: f.scope.chat.conversationId, runId: 'run-a', executionId: 'execution-a' }
        } },
        reads: {
          pinned: async (_runId, ids) => new Map(ids.flatMap((id) => pins.has(id) ? [[id, pins.get(id)!] as const] : [])),
          complete: async (context, source, _at, reauthorize) => {
            await reauthorize({} as FileQuery)
            const value = await f.repository.read(source.fileId, source.revisionId)
            if (!value || !effectiveReference(context, value.value.file.scope)) return 'not_found'
            if (value.value.file.state !== 'ready') return 'not_found'
            const previous = pins.get(source.fileId)
            if (previous && previous !== source.revisionId) throw new DomainError('FILE_REFERENCE_PIN_CONFLICT', 'Changed pin', 409)
            pins.set(source.fileId, source.revisionId)
            return 'ready'
          },
        },
      })
      const resolver = agentFileReferenceResolver(references, f.repository, f.bytes as unknown as FileByteStorage)
      const service = new AgentFileToolService(f.files, f.sessions, f.artifacts, f.tools, resolver, f.clock)
      const app = Fastify()
      app.setErrorHandler((error, _request, reply) => {
        void reply.code(error instanceof DomainError ? error.status : 500)
          .send({ error: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })
      })
      registerFileToolsMcp(app, service)
      await app.ready()
      async function rpc(name: string, args: unknown, credential = token) {
        const response = await app.inject({ method: 'POST', url: FILE_TOOLS_MCP_PATH,
          headers: { host: 'localhost', authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream' },
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })
        const line = response.body.split('\n').find((value) => value.startsWith('data: '))
        const body = JSON.parse(line ? line.slice(6) : response.body) as {
          result?: { isError?: boolean; structuredContent?: unknown }; error?: unknown
        }
        return { response, body }
      }
      async function call(name: string, args: unknown) {
        const { response, body } = await rpc(name, args)
        assert.equal(response.statusCode, 200, response.body)
        assert.equal(body.error, undefined, response.body)
        assert.notEqual(body.result?.isError, true, response.body)
        assert.ok(body.result, response.body)
        assert.ok(decodeMcpToolResult(body.result), response.body)
        return decodeMcpToolResult(body.result)
      }
      try {
        const copy = AgentFileCreateWorkingCopyResultSchema.parse(await call('files.create_working_copy', {
          commandId: randomUUID(), source: ref, destination: f.scope,
        }))
        const snapshot = f.tools.artifacts.get(copy.value.artifactId)!.snapshot!
        assert.deepEqual(f.bytes.objects.get(snapshot.storageKey), Buffer.from(original)) // More than one bounded read.
        assert.equal(pins.get(ref.fileId), ref.revisionId)
        const edited = AgentFileWorkingCopyEditResultSchema.parse(await call('files.write_working_copy', {
          artifactId: copy.value.artifactId, baseRevisionId: snapshot.revision.revisionId,
          contentBase64: Buffer.from('# edited copy\n').toString('base64'),
        }))
        assert.notEqual(edited.revisionId, ref.revisionId)
        const published = AgentFilePublishResultSchema.parse(await call('files.publish_result', {
          commandId: randomUUID(), artifactId: copy.value.artifactId, scope: f.scope,
          filename: 'edited.md', mediaType: 'text/markdown',
        }))
        assert.notEqual(published.value.file.fileId, ref.fileId)
        assert.notEqual(published.value.revision.revisionId, ref.revisionId)
        assert.equal(published.value.file.scope.kind, 'temporary')
        assert.equal(published.value.revision.origin, 'agent_output')
        const result = await service.read(token, { fileId: published.value.file.fileId,
          revisionId: published.value.revision.revisionId })
        assert.equal(result.status, 'ready')
        if (result.status !== 'ready') assert.fail('Published copy is unavailable')
        assert.equal(Buffer.from(result.contentBase64, 'base64').toString(), '# edited copy\n')
        assert.deepEqual(f.repository.values.get(ref.fileId), before)
        assert.deepEqual(f.bytes.objects.get(before.storageKey), Buffer.from(original))
        const readback = await references.forConversation(f.principal, f.scope.chat.conversationId).read({
          ...ref, offset: 0, length: 12,
        })
        assert.equal(readback.status, 'ready')
        assert.equal((await rpc('files.create_working_copy', { commandId: randomUUID(), source: ref,
          destination: f.scope }, 'invalid')).response.statusCode, 401)
      } finally { await app.close() }
    })
  }
})
