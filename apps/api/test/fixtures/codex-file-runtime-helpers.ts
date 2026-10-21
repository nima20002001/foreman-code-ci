import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { AgentFilePublishResult, FileWithRevision, TemporaryFileScope } from '@foreman-code/contracts/files'
import type { CodexFileServices, CodexFileHostLease } from '../../src/modules/harnesses/codexFiles/port.js'
import { fixture } from './codex-test-helpers.js'

/** Extend the existing executable fixture, not a second mock session manager.
 * Assert each insertion point so fixture drift fails loudly. Defaults in the
 * original fixture remain unchanged for all existing tests. */
export async function fileRuntimeFixture() {
  const f = await fixture()
  let binary = await readFile(f.binary, 'utf8')
  const replace = (before: string, after: string) => {
    assert.equal(binary.split(before).length, 2, `missing/ambiguous fixture seam: ${before}`)
    binary = binary.replace(before, after)
  }
  replace("const started = () => {", `const beforeAck = read('file-before-ack.json', null)
    if (beforeAck) {
      outstanding.set(beforeAck.id, { threadId: owner.id, turnId: nativeTurn.id, remaining: 0 })
      send({ ...beforeAck, method: 'item/tool/call', params: {
        ...beforeAck.params, threadId: owner.id, turnId: nativeTurn.id,
      } })
    }
    const started = () => {`)
  replace("['wait', 'slow-start', 'late-start'].includes(prompt)",
    "['wait', 'slow-start', 'late-start'].includes(prompt) || flag('file-turn')")
  // The shared fixture now owns MCP configuration and exact CLI disable flags.
  // Require that current surface rather than patching a retired response shape.
  assert.equal(binary.split('enabled: processDisabledMcp.has(name) ? false : configured.enabled !== false').length, 2,
    'missing/ambiguous shared fixture MCP disable seam')
  await writeFile(f.binary, binary)
  return f
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const bytes = Buffer.from('# Attached document\n')
const now = '2026-09-28T00:00:00.000Z'
export const fileScope: TemporaryFileScope = { kind: 'temporary', chat: {
  kind: 'agent', conversationId: 'conversation-a', agentId: 'agent-a', workspaceId: 'workspace-1', workflowId: 'workflow-1',
} }
export const sourceRef = { fileId: 'source-file', revisionId: 'source-revision' }
export const publishedRef = { fileId: 'published-file', revisionId: 'published-revision' }
const value = {
  file: { fileId: sourceRef.fileId, currentRevisionId: sourceRef.revisionId, scope: fileScope, state: 'ready',
    createdAt: now, expiresAt: '2026-10-05T00:00:00.000Z', retentionDurationSeconds: 604800 },
  revision: { ...sourceRef, filename: 'notes.md', mediaType: 'text/markdown', byteSize: bytes.length,
    sha256: digest(bytes), origin: 'upload', createdAt: now },
} satisfies FileWithRevision

/** FIL-05 and execution-host ports are doubles. The real bridge, manager,
 * transport and production service adapter are used by the integration tests. */
export function filePorts() {
  const events: string[] = []
  const issued: Array<Record<string, unknown>> = []
  const tokens = new Set<string>()
  const copies = new Map<string, Buffer>()
  const materialized: Array<{ path: string; writable: boolean }> = []
  let sequence = 0
  let issueGate: Promise<void> | undefined
  let publishGate: Promise<void> | undefined
  let published = false
  const authenticate = async (token: string) => {
    if (!tokens.has(token)) throw new Error('FILE_SESSION_REVOKED')
    return {} as never
  }
  const files: CodexFileServices = {
    writeWorkingCopy: async () => { throw new Error('FILE_EDIT_UNEXPECTED') },
    applyFormatEdit: async () => { throw new Error('FILE_EDIT_UNEXPECTED') },
    sessions: {
      issueForAcceptedSession: async (context) => {
        events.push('issue:entered')
        issued.push(structuredClone(context) as unknown as Record<string, unknown>)
        await issueGate
        const token = `gql_file_${String(++sequence).padStart(43, 'a')}`
        tokens.add(token); events.push('issue:ready'); return token
      },
      authenticate,
      revoke: async (token) => { tokens.delete(token); events.push('revoke') },
      renew: async (token) => {
        if (!tokens.has(token)) throw new Error('FILE_SESSION_EXPIRED')
        return new Date(Date.now() + 15 * 60_000).toISOString()
      },
    },
    artifacts: {
      beginWrite: async (token) => { await authenticate(token); return 'write-a' },
      abortWrite: async () => undefined,
      completeWrite: async (token, _artifact, _write, stream) => {
        for await (const chunk of stream) { assert.notEqual(chunk, undefined) }
        await authenticate(token); events.push('completeWrite')
      },
    },
    list: async (token) => { await authenticate(token); events.push('list'); return { items: [value], pageInfo: { nextCursor: null } } },
    read: async (token, input) => {
      await authenticate(token)
      const request = input as { offset?: number; length?: number }
      const offset = request.offset ?? 0, data = bytes.subarray(offset, offset + (request.length ?? 65536))
      return { status: 'ready', ...value, readAt: now, offset, byteLength: data.length,
        contentBase64: data.toString('base64'), eof: offset + data.length === bytes.length }
    },
    createWorkingCopy: async (token) => {
      await authenticate(token); events.push('createWorkingCopy')
      return { value: { artifactId: 'artifact-a', source: sourceRef, destination: fileScope, filename: 'notes.md', createdAt: now }, replayed: false }
    },
    publish: async (token) => {
      await authenticate(token); events.push('publish:entered'); await publishGate
      await authenticate(token); events.push('publish:ready')
      const result: AgentFilePublishResult['value'] = { file: { ...value.file, fileId: publishedRef.fileId, currentRevisionId: publishedRef.revisionId },
        revision: { ...value.revision, ...publishedRef, origin: 'agent_output' } }
      const replayed = published; published = true
      return { value: result, replayed }
    },
    publishedForTurn: async (token) => { await authenticate(token); return published ? [publishedRef] : [] },
  }
  const host: CodexFileHostLease = {
    executionHostId: 'execution-host-a', pathStyle: 'posix',
    materialize: async (input) => {
      const chunks: Buffer[] = []
      for await (const chunk of input.bytes) chunks.push(Buffer.from(chunk))
      const data = Buffer.concat(chunks), id = `copy-${copies.size + 1}`
      assert.equal(digest(data), input.sha256)
      copies.set(id, data)
      const path = `/execution-only/${id}/${input.filename}`
      materialized.push({ path, writable: input.writable }); events.push('materialize')
      return { registrationId: id, executionHostId: 'execution-host-a', executionPath: path,
        writable: input.writable, byteSize: data.length, sha256: digest(data) }
    },
    sealCompleted: async (id) => {
      assert(copies.has(id)); events.push('seal'); return Readable.from([copies.get(id)!])
    },
    close: async () => { events.push('host:close') },
  }
  return { files, host, events, issued, tokens, materialized,
    setIssueGate: (gate: Promise<void>) => { issueGate = gate },
    setPublishGate: (gate: Promise<void>) => { publishGate = gate },
    dependencies: { host, clock: () => new Date(now), source: {
      open: async () => ({ value: structuredClone(value), stream: Readable.from([bytes]) }),
      recheck: async () => structuredClone(value),
    } },
  }
}
