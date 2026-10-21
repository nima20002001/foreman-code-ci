import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, it, vi } from 'vitest'
import { MAX_FILE_BYTES, type PermanentFileScope } from '@foreman-code/contracts/files'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { ManagedFileCleanupBytes } from '../src/modules/files/cleanup/bytes.js'
import { PostgresFileCleanupRepository } from '../src/modules/files/cleanup/postgres.js'
import { TemporaryFileCleanupSweeper } from '../src/modules/files/cleanup/sweeper.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { FileRetentionService } from '../src/modules/files/retention.js'
import { readFileRetentionSnapshot } from '../src/modules/files/retentionSnapshot.js'
import { TemporaryFileService } from '../src/modules/files/service.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { FileToolArtifacts } from '../src/modules/files/tools/artifacts.js'
import { bindingIdentity, digest, FileToolSessions } from '../src/modules/files/tools/context.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import { AgentFileToolService } from '../src/modules/files/tools/service.js'
import { ALL_FILE_TOOL_NAMES, type FileToolContext } from '../src/modules/files/tools/types.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

const metadata = (bytes: Buffer) => ({ filename: 'source.md', mediaType: 'text/markdown' as const,
  byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })

// Real PostgreSQL transactions, file services and filesystem. No model/native session or fake
// sweeper. Every case has its own private byte root; the existing helper guards TEST_DATABASE_URL.
describe.skipIf(!postgresEnabled)('FIL-01 artifact byte lifecycle', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let operator: Awaited<ReturnType<PostgresOperatorRepository['ensure']>>
  beforeAll(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    operator = await new PostgresOperatorRepository(database.pool).ensure()
  }, 30_000)
  afterAll(async () => { await database?.close() })

  async function fixture() {
    const owner = await access.issue({ name: 'Artifact cleanup owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'settings:read', 'settings:update'], scope: {} }],
      expiresAt: new Date(Date.now() + 3_600_000) })
    const conversation = await new PostgresOperatorConversationRepository(database.pool)
      .create(operator.operator.id, operator.configuration, owner.principal.id)
    const target = { kind: 'operator' as const, conversationId: conversation.id }
    const authorization = new PostgresFileConversationAuthorization(database.pool)
    const scope = await authorization.resolve(owner.principal, target, 'write')
    const root = await mkdtemp(join(homedir(), '.fil01-artifacts-'))
    const bytes = new FileByteStorage(root, MAX_FILE_BYTES)
    await bytes.initialize()
    const repository = new PostgresFileRepository(database.pool, readFileRetentionSnapshot)
    const retention = new FileRetentionService(database.pool, new PostgresCommandCoordinator(database.pool))
    async function retain(seconds: number, applyToExisting = false) {
      const { preference } = await retention.get(owner.principal, 'http')
      await retention.save(owner.principal, 'http', { commandId: randomUUID(), expectedRevision: preference.revision,
        durationSeconds: seconds, applyToExisting })
    }
    // Accepted files are old but initially live even on PostgreSQL's real clock. Shortening
    // retention later expires them via the real service, without sleeps or rewriting revisions.
    await retain(31_536_000)
    const createdAt = new Date(Date.now() - 8 * 86_400_000).toISOString()
    const files = new TemporaryFileService(repository, bytes, authorization, undefined, () => new Date(createdAt))
    const tools = new PostgresFileToolRepository(database.pool)
    const sessions = new FileToolSessions(tools, (id) => access.currentOperator(id), authorization)
    const artifacts = new FileToolArtifacts(tools, bytes, sessions)
    const service = new AgentFileToolService(files, sessions, artifacts, tools)
    const context: FileToolContext = { ownerPrincipalId: owner.principal.id, scope,
      nativeSessionId: randomUUID(), turnId: randomUUID(), allowMutation: true, allowedTools: [...ALL_FILE_TOOL_NAMES] }
    const tokens: string[] = []
    async function issue() {
      const token = await sessions.issueForAcceptedSession(context, new Date(Date.now() + 600_000))
      tokens.push(token); return token
    }
    const token = await issue()
    async function upload(text: string) {
      const data = Buffer.from(text), requestId = randomUUID()
      await files.allocate(owner.principal, target, { requestId, ...metadata(data) })
      await files.upload(owner.principal, target, requestId, Readable.from([data]))
      const { value } = await files.finalize(owner.principal, target, requestId)
      return { fileId: value.file.fileId, revisionId: value.revision.revisionId }
    }
    async function reference(referenceScope: PermanentFileScope) {
      const data = Buffer.from('permanent reference\n'), fileId = randomUUID(), revisionId = randomUUID()
      const stored = await repository.create({ ownerPrincipalId: owner.principal.id, storageKey: randomUUID(), value: {
        file: { fileId, currentRevisionId: revisionId, scope: referenceScope, state: 'ready', createdAt },
        revision: { fileId, revisionId, ...metadata(data), origin: 'upload', createdAt },
      } })
      const candidate = await bytes.receive(stored.storageKey, Readable.from([data]), stored.value.revision)
      try { await bytes.stage(candidate, stored.value.revision); await bytes.finalize(stored.storageKey, stored.value.revision) }
      finally { await bytes.discard(candidate) }
      return { stored, data }
    }
    async function close() {
      for (const value of tokens) await sessions.revoke(value)
      await removeFixtureDirectory(root)
    }
    return { owner, scope, root, repository, files, bytes, tools, sessions, artifacts, service,
      context, token, issue, upload, reference, retain, close }
  }
  async function sweepAll(root: string) {
    const errors: unknown[] = []
    // New repository, storage and directory cursors: no writer's in-memory state survives.
    const sweeper = new TemporaryFileCleanupSweeper(new PostgresFileCleanupRepository(database.pool),
      new ManagedFileCleanupBytes(new FileByteStorage(root, MAX_FILE_BYTES)), (error) => { errors.push(error) }, { batchSize: 2 })
    try {
      for (let batch = 0; batch < 200; batch++) {
        const result = await sweeper.sweep()
        assert.deepEqual(errors, [])
        if (!result.hasMore) return
      }
      assert.fail('A bounded discovery pass did not finish')
    } finally { await sweeper.stop() }
  }
  async function absent(root: string, key: string) {
    await assert.rejects(readFile(join(root, 'objects', key)), { code: 'ENOENT' })
    await assert.rejects(readdir(join(root, 'staging', key)), { code: 'ENOENT' })
  }

  for (const ending of ['revoked', 'expired'] as const) {
    it(`reclaims source, published bytes and every edited snapshot after the session is ${ending}, preserving both reference kinds`, async () => {
      const f = await fixture()
      try {
        const references = await Promise.all([
          f.reference({ kind: 'workspace_reference', workspaceId: 'permanent-workspace' }),
          f.reference({ kind: 'workflow_reference', workspaceId: 'permanent-workspace', workflowId: 'permanent-workflow' }),
        ])
        const permanentKeys = references.map(({ stored }) => stored.storageKey).sort()
        const source = await f.upload('# original\n')
        const copy = await f.service.createWorkingCopy(f.token, { commandId: randomUUID(), source, destination: f.scope })
        for (const text of ['# first edit\n', '# second edit\n']) {
          await f.service.writeWorkingCopy(f.token, { artifactId: copy.value.artifactId, contentBase64: Buffer.from(text).toString('base64') })
        }
        const published = await f.service.publish(f.token, { commandId: randomUUID(), artifactId: copy.value.artifactId,
          scope: f.scope, filename: 'result.md', mediaType: 'text/markdown' })
        const original = await f.service.read(f.token, source)
        assert.equal(original.status, 'ready')
        if (original.status !== 'ready') assert.fail('Source is unavailable before expiry')
        assert.equal(Buffer.from(original.contentBase64, 'base64').toString(), '# original\n')
        const allKeys = (await readdir(join(f.root, 'objects'))).sort()
        const temporaryKeys = allKeys.filter((key) => !permanentKeys.includes(key))
        // Count disk objects, not implementation-specific registry fields: fails on the old leak.
        assert.equal(temporaryKeys.length, 5) // source + copy + 2 edits + separate published object
        await sweepAll(f.root)
        assert.deepEqual((await readdir(join(f.root, 'objects'))).sort(), allKeys)
        if (ending === 'revoked') await f.sessions.revoke(f.token)
        else await database.pool.query("update file_tool_sessions set expires_at=now()-interval '1 second' where token_hash=$1", [digest(f.token)])
        await f.retain(3600, true)
        await sweepAll(f.root)
        for (const key of temporaryKeys) await absent(f.root, key)
        assert.deepEqual((await readdir(join(f.root, 'objects'))).sort(), permanentKeys)
        assert.deepEqual((await readdir(join(f.root, 'staging'))).sort(), permanentKeys)
        const restarted = new PostgresFileRepository(database.pool)
        for (const ref of [source, { fileId: published.value.file.fileId, revisionId: published.value.revision.revisionId }]) {
          assert.equal((await restarted.read(ref.fileId, ref.revisionId))?.value.file.state, 'expired')
        }
        for (const { stored, data } of references) {
          assert.deepEqual((await restarted.read(stored.value.file.fileId, stored.value.revision.revisionId))?.value, stored.value)
          assert.deepEqual(await readFile(join(f.root, 'objects', stored.storageKey)), data)
        }
      } finally { await f.close() }
    })
  }

  for (const point of ['before publication', 'after publication'] as const) {
    it(`reclaims an interrupted write ${point} even though no snapshot was installed`, async () => {
      const f = await fixture()
      const finalize = f.bytes.finalize.bind(f.bytes)
      const fault = vi.spyOn(f.bytes, 'finalize').mockImplementation(async (...args) => {
        if (point === 'after publication') await finalize(...args)
        throw new Error('synthetic interrupted write')
      })
      try {
        const artifact = await f.artifacts.create(f.token, 'interrupted.md', 'text/markdown')
        await assert.rejects(f.artifacts.completeWrite(f.token, artifact.artifactId, artifact.writeId,
          Readable.from([Buffer.from('unacknowledged bytes\n')])), /synthetic interrupted write/)
        assert.equal((await f.tools.artifact(bindingIdentity(f.context), artifact.artifactId))?.snapshot, undefined)
        const keys = await readdir(join(f.root, 'staging'))
        assert.equal(keys.length, 1)
        assert.equal((await readdir(join(f.root, 'objects'))).length, point === 'after publication' ? 1 : 0)
        await f.sessions.revoke(f.token)
        await sweepAll(f.root)
        for (const key of keys) await absent(f.root, key)
      } finally { fault.mockRestore(); await f.close() }
    })
  }

  it('rechecks a renewed session, commits retirement before failed unlink, and never revives a retired handle', async () => {
    const f = await fixture()
    try {
      const created = await f.artifacts.create(f.token, 'retired.md', 'text/markdown')
      await f.artifacts.completeWrite(f.token, created.artifactId, created.writeId, Readable.from([Buffer.from('old bytes')]))
      const binding = bindingIdentity(f.context)
      const snapshot = (await f.tools.artifact(binding, created.artifactId))!.snapshot!
      await f.sessions.revoke(f.token)
      const cleanup = new PostgresFileCleanupRepository(database.pool).artifacts
      const [candidate] = await cleanup.findByStorageKeys([snapshot.storageKey])
      assert.ok(candidate)
      const renewed = await f.issue()
      assert.equal(await cleanup.remove(candidate, async () => { assert.fail('A live session was swept') }), 'stale')
      await f.sessions.revoke(renewed)
      await assert.rejects(cleanup.remove(candidate, async () => { throw new Error('synthetic disk failure') }), /synthetic disk failure/)
      const retired = await new PostgresFileToolRepository(database.pool).artifact(binding, created.artifactId)
      assert.ok(retired?.retiredAt)
      assert.equal(retired.state, 'failed')
      assert.equal(await f.tools.beginWrite(binding, created.artifactId, randomUUID()), false)
      assert.equal(await f.tools.finishWrite(binding, created.artifactId, created.writeId, snapshot), false)
      assert.equal(await f.tools.registerStorage(binding, created.artifactId, created.writeId, randomUUID()), false)
      const next = await f.issue()
      await assert.rejects(f.artifacts.beginWrite(next, created.artifactId), { code: 'FILE_ARTIFACT_EXPIRED' })
      const fresh = await f.artifacts.create(next, 'fresh.md', 'text/markdown')
      await f.artifacts.completeWrite(next, fresh.artifactId, fresh.writeId, Readable.from([Buffer.from('live bytes')]))
      const freshSnapshot = (await f.tools.artifact(binding, fresh.artifactId))!.snapshot!
      await sweepAll(f.root)
      await absent(f.root, snapshot.storageKey)
      assert.deepEqual(await readFile(join(f.root, 'objects', freshSnapshot.storageKey)), Buffer.from('live bytes'))
    } finally { await f.close() }
  })
})
