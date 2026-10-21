import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { afterEach, describe, it, vi } from 'vitest'
import pg from 'pg'
import { FileWithRevisionSchema, type FileScope } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../src/modules/errors.js'
import type { FileAllocation, FileAllocationRepository, FileRepository, FileMutationContext } from '../src/modules/files/repository.js'
import { FileStorageService } from '../src/modules/files/service.js'
import { FileByteStorage, type FileUploadCandidate } from '../src/modules/files/storage.js'
import { CanonicalJobArtifactPort, type JobPublicationLink } from '../src/modules/files/jobs/port.js'
import { CiOutputByteStorage } from '../src/modules/files/jobs/byteStorage.js'
import { AgentFileToolService } from '../src/modules/files/tools/service.js'
import { fileToolFixture } from './support/fileTools.js'

const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', grants: [],
  expiresAt: '2100-01-01T00:00:00.000Z', revokedAt: null }
const job: FileScope = { kind: 'job_execution', workspaceId: 'workspace', jobExecutionId: 'job' }
const conversation: FileScope = { kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: owner.id,
  operatorId: 'operator', conversationId: 'conversation' } }
const instant = new Date('2026-10-01T12:00:00.000Z')
const metadata = { requestId: 'publication', filename: 'result.bin', mediaType: 'application/octet-stream',
  byteSize: 3, sha256: createHash('sha256').update(Buffer.from([0, 255, 1])).digest('hex') }

class RecordingBytes extends FileByteStorage {
  constructor(private readonly events: string[], readonly afterReceive: () => void) { super('/unused-file-test', 1024) }
  override async receive(): Promise<FileUploadCandidate> { this.events.push('receive'); this.afterReceive(); return { storageKey: randomUUID(), attemptId: randomUUID() } }
  override async stage(): Promise<void> { this.events.push('stage') }
  override async discard(): Promise<void> { this.events.push('discard') }
  override async finalize(): Promise<void> { this.events.push('publish') }
  override async download(): Promise<ReadStream> { this.events.push('download'); return createReadStream('/dev/null') }
}
function fixture(scope: FileScope) {
  const events: string[] = []
  let row: FileAllocation | undefined, allowed = true, time = instant
  const guard: FileMutationContext = { source: 'mcp', authorize: async () => {
    events.push('guard'); if (!allowed) throw new DomainError('PUBLICATION_REVOKED', 'Revoked', 403)
  } }
  const repository: FileRepository & FileAllocationRepository = {
    create: async () => { throw new Error('Unexpected direct create') },
    read: async (fileId, revisionId) => row?.stored.value.file.fileId === fileId && row.stored.value.revision.revisionId === revisionId ? row.stored : undefined,
    list: async () => ({ items: [], pageInfo: { nextCursor: null } }), markExpired: async () => undefined,
    withAllocation: async (_owner, _request, operation, mutation) => {
      // Model the real repository's guard before allocation/read and again before durable writes.
      await mutation?.authorize({ query: async () => { throw new Error('No SQL expected') } })
      events.push('lease-open')
      try { return await operation({ read: async () => row, create: async value => {
        await mutation?.authorize({ query: async () => { throw new Error('No SQL expected') } }); events.push('create'); row = value
      }, setState: async state => {
        await mutation?.authorize({ query: async () => { throw new Error('No SQL expected') } }); assert.ok(row)
        events.push(state); row = { ...row, state, stored: { ...row.stored, value: FileWithRevisionSchema.parse({ ...row.stored.value,
          file: { ...row.stored.value.file, state: state === 'finalized' ? 'ready' : row.stored.value.file.state } }) } }; return row
      } }) } finally { events.push('lease-close') }
    },
  }
  let afterReceive = () => {}
  const bytes = new RecordingBytes(events, () => afterReceive())
  const service = new FileStorageService(repository, bytes, { resolve: async (_principal, _target, _access, query) => {
    events.push(query ? 'scope-commit' : 'scope'); return scope
  } }, async () => { throw new Error('Job retention must come from acceptance') }, () => time)
  return { service, bytes, guard, events, get row() { return row }, revoke: () => { allowed = false },
    duringReceive: (callback: () => void) => { afterReceive = callback }, setTime: (value: Date) => { time = value } }
}

describe('current canonical file publication ports', () => {
  it('releases allocation ownership during finalization and finalized-byte verification', async () => {
    const f = fixture(job)
    await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    await f.service.upload(owner, job, metadata.requestId, Readable.from([]), { commitAuthorization: f.guard })
    for (let attempt = 0; attempt < 2; attempt++) {
      f.events.length = 0
      await f.service.finalize(owner, job, metadata.requestId, 'mcp', f.guard)
      let leased = false
      for (const event of f.events) {
        if (event === 'lease-open') leased = true
        if (event === 'lease-close') leased = false
        if (event === 'publish' || event === 'download') assert.equal(leased, false)
      }
    }
  })
  it('revalidates metadata and authority after filesystem publication', async () => {
    const f = fixture(job)
    await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    vi.spyOn(f.bytes, 'finalize').mockImplementation(async () => { f.revoke() })
    await assert.rejects(f.service.finalize(owner, job, metadata.requestId, 'mcp', f.guard),
      { code: 'PUBLICATION_REVOKED' })
    assert.equal(f.row?.state, 'allocated')
  })

  it('allocates exact CI metadata and accepted retention, and replays original pins', async () => {
    const f = fixture(job)
    const first = await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    assert.equal(first.value.revision.origin, 'job_output')
    assert.equal('byteClass' in first.value.revision && first.value.revision.byteClass, 'ci-output')
    assert.equal('expiresAt' in first.value.file && first.value.file.expiresAt, '2026-10-01T14:00:00.000Z')
    const replay = await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    assert.deepEqual(replay.value, first.value); assert.equal(replay.replayed, true)
    assert.equal(f.events.filter(event => event === 'create').length, 1)
    await assert.rejects(f.service.allocateJobOutput(owner, job, metadata, 'different-output', 7200, f.guard), { code: 'FILE_REQUEST_CONFLICT' })
    await assert.rejects(f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 3600, f.guard), { code: 'FILE_REQUEST_CONFLICT' })
  })
  it('rejects ordinary upload and Agent publication into Job scopes before allocation', async () => {
    const f = fixture(job)
    await assert.rejects(f.service.allocate(owner, job, metadata), { code: 'FILE_BYTE_CLASS_DENIED' })
    await assert.rejects(f.service.allocateAgentResult(owner, job, metadata, 'agent_output', 'agent', f.guard), { code: 'FILE_REFERENCE_READ_ONLY' })
    assert.equal(f.row, undefined)
  })
  it('runs the accepted guard before Job allocation and on idempotent replay', async () => {
    const f = fixture(job)
    await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    f.revoke()
    await assert.rejects(f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard), { code: 'PUBLICATION_REVOKED' })
    assert.equal(f.events.filter(event => event === 'create').length, 1)
  })
  it('honors a distributed Agent guard for temporary scopes before persistence', async () => {
    const f = fixture(conversation); f.revoke()
    await assert.rejects(f.service.allocateAgentResult(owner, conversation, { ...metadata, filename: 'note.md', mediaType: 'text/markdown' }, 'agent_output', 'accepted-agent', f.guard), { code: 'PUBLICATION_REVOKED' })
    assert.equal(f.row, undefined)
  })
  it('rechecks authority after receiving bytes before staging and discards the candidate on denial', async () => {
    const f = fixture(job)
    await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    f.events.length = 0; f.duringReceive(f.revoke)
    await assert.rejects(f.service.upload(owner, job, metadata.requestId, Readable.from([]), { commitAuthorization: f.guard }), { code: 'PUBLICATION_REVOKED' })
    assert.ok(f.events.includes('receive')); assert.ok(f.events.includes('discard'))
    assert.ok(!f.events.includes('stage')); assert.equal(f.row?.state, 'allocated')
  })
  it('guards final publication before byte effects', async () => {
    const f = fixture(job)
    await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    await f.service.upload(owner, job, metadata.requestId, Readable.from([]), { commitAuthorization: f.guard })
    f.events.length = 0; f.revoke()
    await assert.rejects(f.service.finalize(owner, job, metadata.requestId, 'mcp', f.guard), { code: 'PUBLICATION_REVOKED' })
    assert.ok(!f.events.includes('publish')); assert.equal(f.row?.state, 'staged')
  })
  it('denies finalized replay before verifying already committed bytes', async () => {
    const f = fixture(job)
    await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    await f.service.upload(owner, job, metadata.requestId, Readable.from([]), { commitAuthorization: f.guard })
    await f.service.finalize(owner, job, metadata.requestId, 'mcp', f.guard)
    f.events.length = 0; f.revoke()
    await assert.rejects(f.service.finalize(owner, job, metadata.requestId, 'mcp', f.guard), { code: 'PUBLICATION_REVOKED' })
    assert.ok(!f.events.includes('download')); assert.ok(!f.events.includes('publish'))
  })
  it('finalizes exact pins and denies expired Job downloads before opening bytes', async () => {
    const f = fixture(job)
    const first = await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    await f.service.upload(owner, job, metadata.requestId, Readable.from([]), { commitAuthorization: f.guard })
    const finalized = await f.service.finalize(owner, job, metadata.requestId, 'mcp', f.guard)
    assert.equal(finalized.value.file.fileId, first.value.file.fileId); assert.equal(finalized.value.file.state, 'ready')
    f.setTime(new Date('2026-10-01T14:00:00.000Z')); f.events.length = 0
    await assert.rejects(f.service.download(owner, job, { fileId: first.value.file.fileId, revisionId: first.value.revision.revisionId }), { code: 'FILE_BYTES_UNAVAILABLE' })
    assert.ok(!f.events.includes('download'))
  })
})

describe('document and CI byte capability separation', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
  async function storage(ci: boolean) {
    const parent = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const root = await mkdtemp(join(parent, 'publication-bytes-')); roots.push(root)
    return ci ? new CiOutputByteStorage(root, 1024) : new FileByteStorage(root, 1024)
  }
  const binary = Buffer.from([0, 255, 1])
  const expected = { ...metadata, byteClass: 'ci-output' as const, mediaType: 'application/octet-stream' as const }
  it('round-trips binary CI output and rejects it through document storage', async () => {
    const bytes = await storage(true), key = randomUUID()
    const candidate = await bytes.receive(key, Readable.from([binary]), expected)
    await bytes.stage(candidate, expected); await bytes.discard(candidate); await bytes.finalize(key, expected)
    const chunks: Buffer[] = []; for await (const chunk of await bytes.download(key, expected)) chunks.push(chunk as Buffer)
    assert.deepEqual(Buffer.concat(chunks), binary)
    await assert.rejects((await storage(false)).receive(randomUUID(), Readable.from([binary]), expected), { code: 'FILE_BYTE_CLASS_DENIED' })
  })
  it('rejects document uploads through CI storage and invalid CI JSON', async () => {
    const bytes = await storage(true), data = Buffer.from('{bad')
    await assert.rejects(bytes.receive(randomUUID(), Readable.from([]), { filename: 'empty.md', mediaType: 'text/markdown', byteSize: 0,
      sha256: createHash('sha256').update('').digest('hex') }), { code: 'FILE_BYTE_CLASS_DENIED' })
    await assert.rejects(bytes.receive(randomUUID(), Readable.from([data]), { ...expected, filename: 'bad.json', mediaType: 'application/json',
      byteSize: data.length, sha256: createHash('sha256').update(data).digest('hex') }), { code: 'JOB_ARTIFACT_TYPE_INVALID' })
  })
})

describe('Agent file tools keep Job authority explicit', () => {
  it('rejects Job scope listing, pinned reading and copying without resolver or byte access', async () => {
    const f = await fileToolFixture(), ref = await f.upload()
    const stored = f.repository.values.get(ref.fileId)!
    stored.value = FileWithRevisionSchema.parse({ file: { fileId: ref.fileId, currentRevisionId: ref.revisionId,
      scope: job, state: 'ready', createdAt: f.clock().toISOString(), retentionDurationSeconds: 7200,
      expiresAt: new Date(f.clock().getTime() + 7200_000).toISOString() }, revision: {
      ...stored.value.revision, byteClass: 'ci-output', origin: 'job_output', filename: 'output.bin', mediaType: 'application/octet-stream' } })
    let referenceEffects = 0
    const service = new AgentFileToolService(f.files, f.sessions, f.artifacts, f.tools, {
      list: async () => { referenceEffects++; throw new Error('Job scope must not become a reference') },
      read: async () => { referenceEffects++; throw new Error('Job scope must not become a reference') },
      open: async () => { referenceEffects++; throw new Error('Job scope must not become a reference') },
    }, f.clock)
    const initialDownloads = f.bytes.downloads
    await assert.rejects(service.list(f.token, { scope: job }), { code: 'FILE_UNAVAILABLE' })
    assert.deepEqual(await service.read(f.token, ref), { status: 'unavailable', ref, reason: 'forbidden' })
    await assert.rejects(service.createWorkingCopy(f.token, { commandId: 'job-copy-denied', source: ref, destination: f.scope }), { code: 'FILE_UNAVAILABLE' })
    assert.equal(referenceEffects, 0); assert.equal(f.bytes.downloads, initialDownloads)
    assert.equal(f.tools.artifacts.size, 0)
  })
})


describe('canonical Job artifact projection', () => {
  it('returns the current strict Job contract from retained canonical file facts', async () => {
    const f = fixture(job)
    const allocated = await f.service.allocateJobOutput(owner, job, metadata, 'accepted-output', 7200, f.guard)
    const value = FileWithRevisionSchema.parse({ ...allocated.value, file: { ...allocated.value.file, state: 'ready' } })
    const link: JobPublicationLink = { kind: 'job_execution', ownerPrincipalId: owner.id, requestId: metadata.requestId,
      binding: 'accepted-binding', executionId: 'job', workspaceId: 'workspace', attemptId: 'attempt',
      owner: { grantId: 'grant', epoch: '1' }, outputSpecDigest: '1'.repeat(64), specDigest: '2'.repeat(64),
      path: 'result.bin', inputHash: '3'.repeat(64), ref: { fileId: value.file.fileId, revisionId: value.revision.revisionId }, createdAt: instant.toISOString() }
    const principal = { ...owner, grants: [{ actions: ['job_artifacts:read' as const], scope: {} }] }
    const principalRow = { id: principal.id, name: principal.name, audience: principal.audience,
      grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }
    // A standalone Job has no persisted workflow or Agent origin to authorize against.
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('from job_executions') ? [] : [principalRow],
      rowCount: sql.includes('from job_executions') ? 0 : 1, command: 'SELECT', oid: 0, fields: [] }) as unknown as pg.QueryResult)
    const files = new CanonicalJobArtifactPort(new pg.Pool(), f.service, {
      link: async () => { throw new Error('Listing must not mutate a publication receipt') },
      list: async () => [{ link, value }],
    }, { authorizePublication: async () => { throw new Error('Listing must not publish') } },
    { open: async () => { throw new Error('Listing must not open bytes') } }, () => instant)
    assert.deepEqual(await files.list({ query }, principal, 'workspace', 'job'), [{ executionId: 'job', publicationId: metadata.requestId,
      path: 'result.bin', fileId: value.file.fileId, revisionId: value.revision.revisionId, sha256: metadata.sha256,
      byteSize: metadata.byteSize, mediaType: metadata.mediaType, state: 'available', expiresAt: '2026-10-01T14:00:00.000Z' }])
    // Listing only reads: each authorization pass checks the live principal and the Job's persisted origin.
    const statements = query.mock.calls.map(([sql]: [string]) => sql.includes('from job_executions') ? 'execution-scope' : sql.includes('from management_princi') ? 'principal' : sql)
    assert.deepEqual(statements, ['principal', 'execution-scope', 'principal', 'execution-scope'])
    assert.equal('expiresAt' in value.file && value.file.expiresAt, '2026-10-01T14:00:00.000Z')
  })
})
