import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { FileWithRevisionSchema, fileStateAt, type FilePage, type FileScope, type MessageAttachmentRef,
  type RunFileProvenance, type TemporaryFileScope } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../../src/modules/errors.js'
import type { FileConversationAuthorization } from '../../src/modules/files/authorization.js'
import type { AllocationSession, FileAllocation, FileAllocationRepository, FileRepository, StoredFile } from '../../src/modules/files/repository.js'
import { fileScopeIdentity } from '../../src/modules/files/requests.js'
import { TemporaryFileService } from '../../src/modules/files/service.js'
import type { FileByteStorage, FileUploadCandidate } from '../../src/modules/files/storage.js'
import { FileToolArtifacts } from '../../src/modules/files/tools/artifacts.js'
import { FileToolSessions } from '../../src/modules/files/tools/context.js'
import { AgentFileToolService } from '../../src/modules/files/tools/service.js'
import { FILE_TOOL_NAMES, type ArtifactSnapshot, type CopyReceipt, type FileToolArtifact, type FileToolContext,
  type FileToolRepository, type FileToolSession, type PublicationLink } from '../../src/modules/files/tools/types.js'

const clone = <T>(value: T): T => structuredClone(value)
const conflict = () => new DomainError('FILE_REQUEST_CONFLICT', 'Conflicting receipt.', 409)
export class MemoryFiles implements FileRepository, FileAllocationRepository {
  readonly values = new Map<string, StoredFile>()
  readonly allocations = new Map<string, FileAllocation>()
  private readonly queues = new Map<string, Promise<void>>()
  async create(value: StoredFile) { this.values.set(value.value.file.fileId, clone(value)); return clone(value) }
  async read(fileId: string, revisionId: string) {
    const stored = this.values.get(fileId)
    return stored?.value.revision.revisionId === revisionId ? clone(stored) : undefined
  }
  async list(scope: FileScope, page: { limit: number; cursor?: string }, asOfUtc: string): Promise<FilePage> {
    const items = [...this.values.values()].filter(({ value }) => scope.kind === 'temporary' && value.file.scope.kind === 'temporary'
      && fileScopeIdentity(scope) === fileScopeIdentity(value.file.scope)).slice(0, page.limit)
      .map(({ value }) => FileWithRevisionSchema.parse({ ...value, file: { ...value.file, state: fileStateAt(value.file, asOfUtc) } }))
    return { items, pageInfo: { nextCursor: null } }
  }
  async markExpired(fileId: string, asOfUtc: string) {
    const stored = this.values.get(fileId)
    if (!stored) return undefined
    stored.value = FileWithRevisionSchema.parse({ ...stored.value, file: { ...stored.value.file, state: fileStateAt(stored.value.file, asOfUtc) } })
    return stored.value.file
  }
  async withAllocation<T>(owner: string, requestId: string, operation: (session: AllocationSession) => Promise<T>): Promise<T> {
    const key = JSON.stringify([owner, requestId])
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    this.queues.set(key, next)
    await previous
    try {
      return await operation({
        read: async () => { const value = this.allocations.get(key); return value ? clone(value) : undefined },
        create: async (value) => { if (this.allocations.has(key)) throw conflict(); this.allocations.set(key, clone(value)); await this.create(value.stored) },
        setState: async (state) => {
          const allocation = this.allocations.get(key)!
          allocation.state = state
          allocation.stored.value = FileWithRevisionSchema.parse({ ...allocation.stored.value,
            file: { ...allocation.stored.value.file, state: state === 'finalized' ? 'ready' : state === 'canceled' ? 'removed' : 'pending' } })
          this.values.set(allocation.stored.value.file.fileId, clone(allocation.stored))
          return clone(allocation)
        },
      })
    } finally { release(); if (this.queues.get(key) === next) this.queues.delete(key) }
  }
}

/** Unit-test byte boundary. Real type/structure/fs validation remains covered by FIL-03's storage suite. */
export class MemoryBytes {
  readonly objects = new Map<string, Buffer>()
  readonly candidates = new Map<string, Buffer>()
  readonly staged = new Map<string, Buffer>()
  downloads = 0
  async receive(storageKey: string, source: Readable, expected: { byteSize: number; sha256: string }, signal?: AbortSignal) {
    const chunks: Buffer[] = []
    for await (const chunk of source) { if (signal?.aborted) throw new Error('aborted'); chunks.push(Buffer.from(chunk as Uint8Array)) }
    const data = Buffer.concat(chunks)
    if (data.length !== expected.byteSize || createHash('sha256').update(data).digest('hex') !== expected.sha256) throw new Error('Invalid bytes')
    const candidate = { storageKey, attemptId: randomUUID() }
    this.candidates.set(candidate.attemptId, Buffer.from(data)); return candidate
  }
  async stage(candidate: FileUploadCandidate) {
    const data = this.candidates.get(candidate.attemptId)!
    const previous = this.staged.get(candidate.storageKey)
    if (previous && !previous.equals(data)) throw conflict()
    this.staged.set(candidate.storageKey, Buffer.from(data))
  }
  async discard(candidate: FileUploadCandidate) { this.candidates.delete(candidate.attemptId) }
  async finalize(storageKey: string) {
    const staged = this.staged.get(storageKey), existing = this.objects.get(storageKey)
    if (!staged && !existing) throw new Error('Incomplete')
    if (staged && existing && !staged.equals(existing)) throw conflict()
    if (!existing) this.objects.set(storageKey, Buffer.from(staged!))
  }
  async download(storageKey: string, expected: { sha256: string }) {
    this.downloads++
    const data = this.objects.get(storageKey)
    if (!data || createHash('sha256').update(data).digest('hex') !== expected.sha256) throw new Error('Missing or corrupt bytes')
    return Readable.from([Buffer.from(data)])
  }
  async removeUnsent(storageKey: string) { this.objects.delete(storageKey); this.staged.delete(storageKey) }
}
export class MemoryTools implements FileToolRepository {
  readonly sessions = new Map<string, FileToolSession>()
  readonly artifacts = new Map<string, FileToolArtifact>()
  readonly copies = new Map<string, CopyReceipt>()
  readonly links = new Map<string, PublicationLink>()
  readonly reads: RunFileProvenance[] = []
  constructor(private readonly files: MemoryFiles) {}
  async putSession(hash: string, session: FileToolSession) { this.sessions.set(hash, clone(session)) }
  async session(hash: string, now: string) {
    const value = this.sessions.get(hash)
    return value && Date.parse(value.expiresAt) > Date.parse(now) ? clone(value) : undefined
  }
  async revokeSession(hash: string) {
    this.sessions.delete(hash)
  }
  async renewSession(hash: string, expiresAt: string, now: string) {
    const value = this.sessions.get(hash)
    if (!value || Date.parse(value.expiresAt) <= Date.parse(now)) return false
    value.expiresAt = expiresAt
    return true
  }
  async createArtifact(value: FileToolArtifact) { this.artifacts.set(value.artifactId, clone(value)) }
  async artifact(binding: string, id: string) {
    const value = this.artifacts.get(id); return value?.binding === binding ? clone(value) : undefined
  }
  async beginWrite(binding: string, id: string, writeId: string, baseRevisionId?: string) {
    const value = this.artifacts.get(id)
    if (!value || value.binding !== binding || value.retiredAt || value.state === 'writing'
      || (baseRevisionId !== undefined && value.snapshot?.revision.revisionId !== baseRevisionId)) return false
    value.state = 'writing'; value.writeId = writeId; return true
  }
  async registerStorage(binding: string, id: string, writeId: string, storageKey: string) {
    const value = this.artifacts.get(id)
    if (!value || value.binding !== binding || value.writeId !== writeId || value.retiredAt || value.state !== 'writing') return false
    value.storageKeys = [...new Set([...(value.storageKeys ?? []),
      ...(value.snapshot ? [value.snapshot.storageKey] : []), storageKey])]
    return true
  }
  async finishWrite(binding: string, id: string, writeId: string, snapshot: ArtifactSnapshot) {
    const value = this.artifacts.get(id)
    if (!value || value.binding !== binding || value.writeId !== writeId || value.retiredAt || value.state !== 'writing') return false
    value.state = 'complete'; value.snapshot = clone(snapshot); return true
  }
  async failWrite(binding: string, id: string, writeId: string) {
    const value = this.artifacts.get(id)
    if (value?.binding === binding && value.writeId === writeId && value.state === 'writing') value.state = 'failed'
  }
  async copyReceipt(owner: string, id: string) { const value = this.copies.get(JSON.stringify([owner, id])); return value ? clone(value) : undefined }
  async saveCopyReceipt(receipt: CopyReceipt) {
    const key = JSON.stringify([receipt.ownerPrincipalId, receipt.commandId]), previous = this.copies.get(key)
    if (previous && previous.inputHash !== receipt.inputHash) throw conflict()
    if (!previous) this.copies.set(key, clone(receipt))
    return clone(previous ?? receipt)
  }
  async linkPublication(link: PublicationLink) {
    const key = JSON.stringify([link.ownerPrincipalId, link.requestId]), previous = this.links.get(key)
    if (previous && (previous.binding !== link.binding || JSON.stringify(previous.ref) !== JSON.stringify(link.ref))) throw conflict()
    if (!previous) this.links.set(key, clone(link))
  }
  async publications(binding: string): Promise<MessageAttachmentRef[]> {
    return [...this.links.values()].filter((link) => link.binding === binding
      && this.files.allocations.get(JSON.stringify([link.ownerPrincipalId, link.requestId]))?.state === 'finalized').map((link) => clone(link.ref))
  }
  async recordRead(_binding: string, provenance: RunFileProvenance) { this.reads.push(clone(provenance)) }
}

export async function fileToolFixture() {
  let now = new Date('2026-01-01T00:00:00.000Z'), revoked = false, writesAllowed = true
  const clock = () => now
  const principal: ManagementPrincipal = { id: 'owner-1', name: 'Owner', audience: 'operator',
    grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'operator_chat:read', 'operator_chat:write'], scope: {} }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const scope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation-a',
    agentId: 'agent-a', workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', executionId: 'execution-a' } }
  const foreign: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation-b',
    agentId: 'agent-a', workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-b', executionId: 'execution-b' } }
  const scopes = new Map([[scope.chat.conversationId, scope], [foreign.chat.conversationId, foreign]])
  const authorization: FileConversationAuthorization = { resolve: async (owner, target, access) => {
    if (revoked || owner.id !== principal.id || (access === 'write' && !writesAllowed)) throw new DomainError('DENIED', 'Denied.', 403)
    const resolved = scopes.get(target.conversationId)
    if (!resolved) throw new DomainError('NOT_FOUND', 'Not found.', 404)
    return clone(resolved)
  } }
  const repository = new MemoryFiles(), bytes = new MemoryBytes(), tools = new MemoryTools(repository)
  const files = new TemporaryFileService(repository, bytes as unknown as FileByteStorage, authorization, undefined, clock)
  const context: FileToolContext = { ownerPrincipalId: principal.id, scope, nativeSessionId: 'native-a', turnId: 'turn-a',
    allowMutation: true, allowedTools: [...FILE_TOOL_NAMES] }
  const sessions = new FileToolSessions(tools, async () => { if (revoked) throw new DomainError('REVOKED', 'Revoked.', 401); return clone(principal) }, authorization, clock)
  const artifacts = new FileToolArtifacts(tools, bytes as unknown as FileByteStorage, sessions, clock)
  const service = new AgentFileToolService(files, sessions, artifacts, tools, undefined, clock)
  const token = await sessions.issueForAcceptedSession(context, new Date(now.getTime() + 3_600_000))
  const issue = (changes: Partial<FileToolContext> = {}) => sessions.issueForAcceptedSession({ ...context, ...changes }, new Date(now.getTime() + 3_600_000))
  async function upload(data = '# original\n', destination = scope) {
    const body = Buffer.from(data), requestId = randomUUID()
    const target = { kind: 'agent' as const, workspaceId: 'workspace-a', conversationId: destination.chat.conversationId }
    await files.allocate(principal, target, { requestId, filename: 'source.md', mediaType: 'text/markdown', byteSize: body.length,
      sha256: createHash('sha256').update(body).digest('hex') })
    await files.upload(principal, target, requestId, Readable.from([body]))
    const result = await files.finalize(principal, target, requestId)
    return { fileId: result.value.file.fileId, revisionId: result.value.revision.revisionId }
  }
  return { context, scope, foreign, scopes, principal, repository, bytes, files, tools, sessions, artifacts, service, token, issue, upload,
    clock, advance: (ms: number) => { now = new Date(now.getTime() + ms) },
    revoke: () => { revoked = true }, denyWrites: () => { writesAllowed = false } }
}
