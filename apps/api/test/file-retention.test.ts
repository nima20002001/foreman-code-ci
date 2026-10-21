import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, it } from 'vitest'
import {
  DEFAULT_FILE_RETENTION_SECONDS, FileWithRevisionSchema, TemporaryFileSchema,
  applyFileRetention, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { toolRoles } from '../src/mcp/unified/roles.js'
import { fileRetentionGrantsAllow } from '../src/modules/files/retention.js'
import type { FileAllocation, FileAllocationRepository, FileRepository } from '../src/modules/files/repository.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import type { FileByteStorage } from '../src/modules/files/storage.js'

const owner: ManagementPrincipal = {
  id: 'retention-owner', name: 'Owner', audience: 'operator',
  grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }],
  expiresAt: '2100-01-01T00:00:00.000Z', revokedAt: null,
}
const scope: TemporaryFileScope = { kind: 'temporary', chat: {
  kind: 'operator', ownerPrincipalId: owner.id, operatorId: 'operator', conversationId: 'conversation',
} }
const target = { kind: 'operator' as const, conversationId: 'conversation' }
const upload = { requestId: 'retention-allocation', filename: 'note.md', mediaType: 'text/markdown',
  byteSize: 0, sha256: createHash('sha256').update('').digest('hex') }

/** Only the allocation/storage seam is synthetic. PostgreSQL/authenticated transports are tested separately. */
function fixture(atomic: boolean, reader?: () => Promise<number>, resolvedScope: TemporaryFileScope = scope) {
  let instant = new Date('2026-01-10T12:00:00.000Z'), duration = 3600, reads = 0
  let row: FileAllocation | undefined
  let beforeBuild: (() => void) | undefined, duringVerification: (() => void) | undefined
  const stream = Readable.from([])
  const repository: FileRepository & FileAllocationRepository = {
    create: async () => { throw new Error('Use allocation creation') },
    read: async (fileId, revisionId) => row?.stored.value.file.fileId === fileId
      && row.stored.value.revision.revisionId === revisionId ? row.stored : undefined,
    list: async () => ({ items: [], pageInfo: { nextCursor: null } }),
    markExpired: async () => undefined,
    withAllocation: async (_ownerId, _requestId, operation) => operation({
      read: async () => row,
      create: async (value) => { row = value },
      ...(atomic ? { createWithRetention: async (build: (seconds: number) => FileAllocation) => {
        reads++; beforeBuild?.(); row = build(duration); return row
      } } : {}),
      setState: async () => { throw new Error('Not used by these allocation tests') },
    }),
  }
  const bytes = { download: async () => { duringVerification?.(); return stream } } as unknown as FileByteStorage
  const service = new TemporaryFileService(repository, bytes, { resolve: async () => resolvedScope }, reader, () => instant)
  return {
    service, stream, get reads() { return reads }, get row() { assert.ok(row); return row },
    setDuration: (seconds: number) => { duration = seconds },
    setTime: (utc: string) => { instant = new Date(utc) },
    beforeBuild: (work: () => void) => { beforeBuild = work },
    duringVerification: (work: () => void) => { duringVerification = work },
    updateFile: (work: (file: FileAllocation['stored']['value']['file']) => FileAllocation['stored']['value']['file']) => {
      assert.ok(row)
      row = { ...row, stored: { ...row.stored, value: FileWithRevisionSchema.parse({
        ...row.stored.value, file: work(row.stored.value.file),
      }) } }
    },
  }
}

describe('FIL-40 allocation preference seam', () => {
  it('keeps the seven-day default for adapters without persisted preferences', async () => {
    const f = fixture(false)
    const result = await f.service.allocate(owner, target, upload)
    const file = TemporaryFileSchema.parse(result.value.file)
    assert.equal(file.retentionDurationSeconds, DEFAULT_FILE_RETENTION_SECONDS)
    assert.equal(file.expiresAt, '2026-01-17T12:00:00.000Z')
  })

  it('retains compatibility with the existing injected non-default preference reader', async () => {
    const f = fixture(false, async () => 7200)
    const result = await f.service.allocate(owner, target, upload)
    assert.equal(TemporaryFileSchema.parse(result.value.file).expiresAt, '2026-01-10T14:00:00.000Z')
  })

  it('uses the transactional snapshot for new allocations and never re-reads it on replay', async () => {
    const f = fixture(true, async () => { throw new Error('Out-of-transaction reader must not be used') })
    const first = await f.service.allocate(owner, target, upload)
    assert.equal(TemporaryFileSchema.parse(first.value.file).retentionDurationSeconds, 3600)
    f.setDuration(31536000)
    const replay = await f.service.allocate(owner, target, upload)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.value, first.value)
    assert.equal(f.reads, 1)
    await assert.rejects(f.service.allocate(owner, target, { ...upload, filename: 'changed.md' }), { code: 'FILE_REQUEST_CONFLICT' })
  })

  it('uses the allocating human owner for Agent chat without inventing conversation ownership', async () => {
    const agentScope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent',
      conversationId: 'agent-conversation', agentId: 'agent', workspaceId: 'workspace', workflowId: 'workflow',
    } }
    const f = fixture(true, undefined, agentScope)
    f.setDuration(86400)
    const file = TemporaryFileSchema.parse((await f.service.allocate(owner, {
      kind: 'agent', conversationId: 'agent-conversation', workspaceId: 'workspace',
    }, upload)).value.file)
    assert.equal(file.retentionDurationSeconds, 86400)
    assert.deepEqual(file.scope, agentScope)
    assert.equal(f.row.stored.ownerPrincipalId, owner.id)
    assert.equal('ownerPrincipalId' in file.scope.chat, false)
  })

  it('samples createdAt only after the transactional preference reader obtains its lock', async () => {
    const f = fixture(true)
    f.beforeBuild(() => f.setTime('2026-01-11T10:00:00.000Z'))
    const file = TemporaryFileSchema.parse((await f.service.allocate(owner, target, upload)).value.file)
    assert.equal(file.createdAt, '2026-01-11T10:00:00.000Z')
    assert.equal(file.expiresAt, '2026-01-11T11:00:00.000Z')
  })

  it.each([3599, 31536001, 3600.5])('rejects an invalid internal snapshot %s before creation', async (duration) => {
    const f = fixture(true)
    f.setDuration(duration)
    await assert.rejects(f.service.allocate(owner, target, upload))
  })

  it('rechecks persisted retention after byte verification and closes a now-expired stream', async () => {
    const f = fixture(true)
    f.setDuration(604800)
    const original = await f.service.allocate(owner, target, upload)
    f.updateFile((file) => ({ ...file, state: 'ready' }))
    f.setTime('2026-01-10T14:00:00.000Z')
    f.duringVerification(() => f.updateFile((file) => applyFileRetention(file, 3600, '2026-01-10T14:00:00.000Z')))
    await assert.rejects(f.service.download(owner, target, {
      fileId: original.value.file.fileId, revisionId: original.value.revision.revisionId,
    }), { code: 'FILE_BYTES_UNAVAILABLE' })
    assert.equal(f.stream.destroyed, true)
    assert.deepEqual(f.row.stored.value.revision, original.value.revision)
  })
})

describe('FIL-40 grant and MCP-role discovery', () => {
  it('requires unscoped settings read/write grants and never admits a worker', () => {
    assert.equal(fileRetentionGrantsAllow(owner, true), true)
    const reader = { ...owner, grants: [{ actions: ['settings:read' as const], scope: {} }] }
    assert.equal(fileRetentionGrantsAllow(reader), true)
    assert.equal(fileRetentionGrantsAllow(reader, true), false)
    assert.equal(fileRetentionGrantsAllow({ ...owner, grants: [{ ...owner.grants[0]!, scope: { workspaceIds: ['workspace'] } }] }, true), false)
    assert.equal(fileRetentionGrantsAllow({ ...owner, audience: 'worker', agentId: 'agent' }, true), false)
    assert.equal(fileRetentionGrantsAllow({ ...owner, revokedAt: '2026-01-01T00:00:00.000Z' }, true), false)
    assert.equal(fileRetentionGrantsAllow({ ...owner, expiresAt: '2000-01-01T00:00:00.000Z' }, true), false)
  })

  it.each(['file_retention_get', 'file_retention_preview', 'file_retention_save'])('%s is Operator-only, never an Agent tool', (name) => {
    assert.deepEqual(toolRoles(name), ['operator'])
  })
})
