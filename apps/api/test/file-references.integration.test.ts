import { decodeMcpToolResult, OperatorCompactCapabilitiesSchema } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { afterAll, beforeAll, describe, it } from 'vitest'
import {
  FilePageSchema, FileWithRevisionSchema, MAX_FILE_BYTES, MAX_FILE_READ_BYTES,
  applyFileRetention, fileStateAt, type FileWithRevision, type PermanentFileScope,
} from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ApiConfig } from '../src/config.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileReferenceMigration } from '../src/infrastructure/fileReferenceMigration.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresFileRepository } from '../src/modules/files/postgres.js'
import { registerProductionFileStorage } from '../src/modules/files/production.js'
import { FileByteStorage } from '../src/modules/files/storage.js'
import { PostgresFileReferenceAuthorization } from '../src/modules/files/references/authorization.js'
import { FileReferenceService } from '../src/modules/files/references/service.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { FILE_REFERENCE_TOOL_NAMES } from '../src/mcp/operator/tools/fileReferences.js'
import { FileReferenceReadResultSchema } from '@foreman-code/contracts/files'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'

/** Real credentials, PostgreSQL, disk storage and authenticated /mcp. No harness or paid model. */
describe.skipIf(!postgresEnabled)('FIL-36 permanent reference HTTP + Operator MCP integration', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, app: FastifyInstance, root: string, mcpUrl: string
  let access: PostgresAccessService, commands: PostgresCommandCoordinator, repository: PostgresFileRepository
  let references: FileReferenceService, owner: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>, foreign: Awaited<ReturnType<PostgresAccessService['issue']>>
  let workspace: PermanentFileScope, workflow: PermanentFileScope, sibling: PermanentFileScope, otherWorkspace: PermanentFileScope
  const text = Buffer.from('# Permanent reference\nmarker FIL-36\n', 'utf8')
  const metadata = (bytes = text, filename = 'same-name.md') => ({ filename, mediaType: 'text/markdown' as const,
    byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  const base = (scope: PermanentFileScope) => scope.kind === 'workspace_reference'
    ? `/api/workspaces/${scope.workspaceId}/reference-files`
    : `/api/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/reference-files`
  const pinned = (scope: PermanentFileScope, row: FileWithRevision) => `${base(scope)}/${row.file.fileId}/revisions/${row.revision.revisionId}`
  const headers = (token = owner.token) => ({ authorization: `Bearer ${token}`, host: 'localhost' })

  beforeAll(async () => {
    database = await agent3Database()
    for (const migration of [fileStorageMigration, fileReferenceMigration]) {
      if ((await database.pool.query('select 1 from application_migrations where version=$1', [migration.version])).rowCount) continue
      await withTransaction(database.pool, async client => {
        await client.query(migration.sql)
        await client.query('insert into application_migrations(version) values($1)', [migration.version])
      })
    }
    root = await mkdtemp(join(homedir(), '.fil36-integration-'))
    access = new PostgresAccessService(database.pool)
    commands = new PostgresCommandCoordinator(database.pool)
    repository = new PostgresFileRepository(database.pool)
    const workspaceId = `fil36-${randomUUID()}`, otherId = `fil36-${randomUUID()}`
    for (const id of [workspaceId, otherId]) {
      await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [id, JSON.stringify({ id, name: 'FIL-36 test' })])
    }
    const grant = (actions: ManagementPrincipal['grants'][number]['actions'], workspaceIds: string[]) => [{ actions, scope: { workspaceIds } }]
    owner = await access.issue({ name: 'Reference editor', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: grant(['capabilities:read', 'workspaces:read', 'workspaces:update', 'workflows:create', 'workflows:read', 'workflows:update'], [workspaceId, otherId]) })
    reader = await access.issue({ name: 'Reference reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: grant(['workspaces:read', 'workflows:read'], [workspaceId]) })
    foreign = await access.issue({ name: 'Foreign editor', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: grant(['workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update'], [otherId]) })
    const workflows = new WorkflowManagementService(database.pool, commands)
    const create = async () => (await workflows.create(owner.principal, 'http', { workspaceId, commandId: randomUUID(), name: 'References' })).value.workflow.id
    workspace = { kind: 'workspace_reference', workspaceId }
    workflow = { kind: 'workflow_reference', workspaceId, workflowId: await create() }
    sibling = { kind: 'workflow_reference', workspaceId, workflowId: await create() }
    otherWorkspace = { kind: 'workspace_reference', workspaceId: otherId }
    app = Fastify()
    registerOperatorHttpSecurity(app, access)
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500)
      .send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_REQUEST' } }))
    // Only commands/workflows are needed by this fixture. Other product tools are never called.
    const services = { commands, workflows } as OperatorServices
    registerGraphqlMcp(app, { access, operator: services })
    registerProductionFileStorage(app, database.pool, { fileStorageRoot: root, workspaceStorageRoot: join(database.directory, 'projects'),
      harnesses: { workspaceRoot: join(database.directory, 'harnesses') } } as ApiConfig)
    references = app.getDecorator<FileReferenceService>('fileReferenceService')
    await app.ready()
    // Production startup registers FIL-03 after MCP; both adapters must bind this exact service.
    assert.equal(services.fileReferences, references)
    mcpUrl = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
  }, 60_000)
  afterAll(async () => { await app?.close(); if (root) await removeFixtureDirectory(root); await database?.close() })

  async function allocate(scope: PermanentFileScope, bytes = text, requestId = randomUUID()) {
    const response = await app.inject({ method: 'POST', url: `${base(scope)}/uploads`, headers: headers(), payload: { requestId, ...metadata(bytes) } })
    assert.equal(response.statusCode, 201, response.body)
    return { requestId, row: FileWithRevisionSchema.parse(response.json().value) }
  }
  const upload = (scope: PermanentFileScope, requestId: string, bytes = text) => app.inject({ method: 'PUT',
    url: `${base(scope)}/uploads/${requestId}`, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: bytes })
  const finalize = (scope: PermanentFileScope, requestId: string) => app.inject({ method: 'POST',
    url: `${base(scope)}/uploads/${requestId}/finalize`, headers: headers(), payload: {} })
  async function add(scope: PermanentFileScope, bytes = text) {
    const allocated = await allocate(scope, bytes)
    const sent = await upload(scope, allocated.requestId, bytes); assert.equal(sent.statusCode, 200, sent.body)
    const done = await finalize(scope, allocated.requestId); assert.equal(done.statusCode, 200, done.body)
    return { ...allocated, row: FileWithRevisionSchema.parse(done.json().value) }
  }
  async function rpc(token: string, method: string, params: unknown) {
    const response = await fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const body = await response.text()
    assert.equal(response.status, 200, body)
    const data = body.trim().startsWith('{') ? body
      : body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).find((line) => {
        try { return JSON.parse(line).id === 1 } catch { return false }
      })
    assert.ok(data, body)
    return JSON.parse(data) as { result: { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[]; tools?: { name: string }[] } }
  }
  const tool = (token: string, name: string, args: unknown) => rpc(token, 'tools/call', { name, arguments: args })
  const errorCode = (result: Awaited<ReturnType<typeof rpc>>['result']) => JSON.parse(result.content?.find((part) => part.type === 'text')?.text ?? '{}').error?.code

  it('filters compact reference capabilities by the selected hierarchy and preserves scoped readback', async () => {
    if (workflow.kind !== 'workflow_reference' || sibling.kind !== 'workflow_reference') {
      throw new Error('Workflow reference scopes are required')
    }
    const editor = await access.issue({ name: 'Scoped reference editor', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [
        { actions: ['capabilities:read'], scope: {} },
        { actions: ['workflows:read', 'workflows:update'], scope: {
          workspaceIds: [workflow.workspaceId], workflowIds: [workflow.workflowId],
        } },
      ] })
    const capabilities = async (resource: Record<string, unknown>) => {
      const response = await tool(editor.token, 'operator_get_capabilities', resource)
      assert.notEqual(response.result.isError, true)
      return OperatorCompactCapabilitiesSchema.parse(decodeMcpToolResult(response.result))
    }
    const resource = { workspaceId: workflow.workspaceId, workflowId: workflow.workflowId, runId: 'selected-run' }
    for (const input of [{}, resource]) {
      const result = await capabilities(input)
      for (const name of FILE_REFERENCE_TOOL_NAMES) assert.ok(result.tools.includes(name))
    }
    for (const input of [{ ...resource, workspaceId: otherWorkspace.workspaceId },
      { ...resource, workflowId: sibling.workflowId }, { workspaceId: workflow.workspaceId }]) {
      const result = await capabilities(input)
      for (const name of FILE_REFERENCE_TOOL_NAMES) assert.ok(!result.tools.includes(name))
    }
    const requestId = randomUUID()
    const added = await tool(editor.token, 'reference_file_add', { scope: workflow,
      upload: { requestId, ...metadata() }, contentBase64: text.toString('base64') })
    assert.notEqual(added.result.isError, true)
    const row = FileWithRevisionSchema.parse(decodeMcpToolResult(added.result).value)
    const listed = await tool(editor.token, 'reference_files_list', { scope: workflow })
    const page = FilePageSchema.parse(decodeMcpToolResult(listed.result))
    assert.ok(page.items.some((item) => item.file.fileId === row.file.fileId))
    const readback = FileReferenceReadResultSchema.parse(decodeMcpToolResult(
      (await tool(editor.token, 'reference_file_read', { scope: workflow,
        fileId: row.file.fileId, revisionId: row.revision.revisionId, offset: 0, length: text.length })).result,
    )).value
    assert.equal(readback.status, 'ready')
    if (readback.status !== 'ready') throw new Error('Reference bytes must be ready')
    assert.equal(readback.contentBase64, text.toString('base64'))
    assert.deepEqual(readback.revision, row.revision)
    assert.deepEqual((await repository.read(row.file.fileId, row.revision.revisionId))?.value, row)
    const denied = await tool(editor.token, 'reference_files_list', { scope: sibling })
    assert.equal(denied.result.isError, true)
    assert.equal(errorCode(denied.result), 'ACCESS_DENIED')
    assert.deepEqual(FilePageSchema.parse(decodeMcpToolResult(
      (await tool(editor.token, 'reference_files_list', { scope: workflow })).result)), page)
  })

  for (const kind of ['workspace_reference', 'workflow_reference'] as const) {
    it(`${kind}: add/list/download/remove and retained metadata`, async () => {
      const scope = kind === 'workspace_reference' ? workspace : workflow
      const { row } = await add(scope)
      assert.equal(row.file.state, 'ready'); assert.equal('expiresAt' in row.file, false)
      assert.equal('retentionDurationSeconds' in row.file, false)
      const listed = await app.inject({ method: 'GET', url: base(scope), headers: headers(reader.token) })
      assert.equal(listed.statusCode, 200, listed.body)
      assert.ok(FilePageSchema.parse(listed.json()).items.some((item) => item.file.fileId === row.file.fileId))
      const content = await app.inject({ method: 'GET', url: `${pinned(scope, row)}/content`, headers: headers(reader.token) })
      assert.equal(content.statusCode, 200, content.body); assert.deepEqual(content.rawPayload, text)
      assert.equal(content.headers['x-content-type-options'], 'nosniff')
      assert.equal(content.headers['cache-control'], 'private, no-store')
      assert.match(String(content.headers['content-disposition']), /^attachment;/)
      const commandId = randomUUID()
      const remove = () => app.inject({ method: 'DELETE', url: pinned(scope, row), headers: headers(), payload: { commandId } })
      const removed = await remove(); assert.equal(removed.statusCode, 200, removed.body)
      assert.equal(removed.json().value.file.state, 'removed'); assert.equal((await remove()).json().replayed, true)
      assert.equal((await app.inject({ method: 'GET', url: `${pinned(scope, row)}/content`, headers: headers() })).statusCode, 410)
      const stored = await repository.read(row.file.fileId, row.revision.revisionId)
      assert.deepEqual(stored?.value.revision, row.revision); assert.equal(stored?.value.file.state, 'removed')
      assert.ok(FilePageSchema.parse((await app.inject({ method: 'GET', url: base(scope), headers: headers() })).json()).items
        .some((item) => item.file.fileId === row.file.fileId && item.file.state === 'removed'))
    })
  }
  it('denies foreign workspace access and pins the exact workflow lineage', async () => {
    const { row, requestId } = await add(workflow)
    for (const [method, url, payload] of [
      ['GET', base(workflow), undefined], ['GET', `${pinned(workflow, row)}/content`, undefined],
      ['POST', `${base(workflow)}/uploads`, { requestId: randomUUID(), ...metadata() }],
      ['POST', `${base(workflow)}/uploads/${requestId}/finalize`, {}],
      ['DELETE', pinned(workflow, row), { commandId: randomUUID() }],
    ] as const) {
      assert.equal((await app.inject({ method, url, headers: headers(foreign.token), ...(payload ? { payload } : {}) })).statusCode, 403)
    }
    assert.equal((await app.inject({ method: 'GET', url: `${pinned(sibling, row)}/content`, headers: headers() })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: `${pinned(workspace, row)}/content`, headers: headers() })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: `${base(workflow)}/${row.file.fileId}/revisions/missing/content`, headers: headers() })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: base(workspace), headers: { host: 'localhost', authorization: 'Bearer invalid' } })).statusCode, 401)
  })
  it('keeps same filenames in all scopes distinct; cursors cannot cross scopes', async () => {
    const scopes = [workspace, workflow, sibling, otherWorkspace]
    const contents = scopes.map((_scope, index) => Buffer.from(`Same name, different scope ${index}\n`, 'utf8'))
    const rows = await Promise.all(scopes.map((scope, index) => add(scope, contents[index]!)))
    for (const [index, item] of rows.entries()) {
      const download = await app.inject({ method: 'GET', url: `${pinned(scopes[index]!, item.row)}/content`, headers: headers() })
      assert.deepEqual(download.rawPayload, contents[index])
    }
    assert.equal(new Set(rows.map(({ row }) => row.file.fileId)).size, 4)
    assert.equal(new Set(rows.map(({ row }) => row.revision.revisionId)).size, 4)
    assert.equal(new Set(rows.map(({ row }) => row.revision.filename)).size, 1)
    const page = FilePageSchema.parse((await app.inject({ method: 'GET', url: `${base(workspace)}?limit=1`, headers: headers() })).json())
    assert.ok(page.pageInfo.nextCursor)
    assert.equal((await app.inject({ method: 'GET', url: `${base(workflow)}?limit=1&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`, headers: headers() })).statusCode, 400)
    const ids = new Set<string>(); let cursor: string | null = null
    do {
      const page = await references.list(owner.principal, workspace, { limit: 1, ...(cursor ? { cursor } : {}) })
      for (const item of page.items) { assert.equal(ids.has(item.file.fileId), false); ids.add(item.file.fileId) }
      cursor = page.pageInfo.nextCursor
    } while (cursor)
    assert.ok(ids.has(rows[0]!.row.file.fileId)); assert.equal(ids.has(rows[1]!.row.file.fileId), false)
  })
  it('replays allocation/finalize without changing bytes or revision; changed identity conflicts', async () => {
    const { row, requestId } = await add(workspace)
    const replay = await app.inject({ method: 'POST', url: `${base(workspace)}/uploads`, headers: headers(), payload: { requestId, ...metadata() } })
    assert.equal(replay.statusCode, 200); assert.equal(replay.json().replayed, true)
    assert.deepEqual(replay.json().value, row); assert.equal((await finalize(workspace, requestId)).json().replayed, true)
    assert.equal((await upload(workspace, requestId)).json().replayed, true)
    for (const scope of [workspace, workflow]) {
      const conflict = await app.inject({ method: 'POST', url: `${base(scope)}/uploads`, headers: headers(),
        payload: { requestId, ...metadata(text, scope === workspace ? 'renamed.md' : 'same-name.md') } })
      assert.equal(conflict.statusCode, 409)
    }
    assert.equal((await upload(workspace, requestId, Buffer.alloc(text.length, 120))).statusCode, 422)
    const unsupported = await app.inject({ method: 'PATCH', url: pinned(workspace, row), headers: headers(), payload: { filename: 'replacement.md' } })
    assert.equal(unsupported.statusCode, 403)
    assert.equal(unsupported.json().error.code, 'ACCESS_DENIED')
    const stored = await repository.read(row.file.fileId, row.revision.revisionId)
    assert.deepEqual(stored?.value, row)
    assert.equal((await stat(join(root, 'objects', stored!.storageKey))).mode & 0o222, 0)
    await assert.rejects(database.pool.query('update file_revisions set filename=$2 where revision_id=$1', [row.revision.revisionId, 'overwritten.md']))
    await assert.rejects(database.pool.query('delete from file_revisions where revision_id=$1', [row.revision.revisionId]))
    await assert.rejects(database.pool.query('update files set workspace_id=$2 where file_id=$1', [row.file.fileId, otherWorkspace.workspaceId]))
    await assert.rejects(database.pool.query("update files set state='pending' where file_id=$1", [row.file.fileId]))
    assert.equal((await app.inject({ method: 'GET', url: `${pinned(workspace, row)}/content`, headers: headers() })).rawPayload.equals(text), true)
  })
  it('removal requires current rights, not upload ownership, and command IDs cannot target another file', async () => {
    const { row: first } = await add(workspace), { row: second } = await add(workspace)
    const editor = await access.issue({ name: 'Second reference editor', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['workspaces:read', 'workspaces:update'], scope: { workspaceIds: [workspace.workspaceId] } }] })
    const commandId = randomUUID()
    const removed = await app.inject({ method: 'DELETE', url: pinned(workspace, first), headers: headers(editor.token), payload: { commandId } })
    assert.equal(removed.statusCode, 200, removed.body)
    assert.equal(removed.json().value.file.state, 'removed')
    const conflict = await app.inject({ method: 'DELETE', url: pinned(workspace, second), headers: headers(editor.token), payload: { commandId } })
    assert.equal(conflict.statusCode, 409, conflict.body)
    assert.equal(conflict.json().error.code, 'COMMAND_ID_CONFLICT')
    assert.equal((await repository.read(second.file.fileId, second.revision.revisionId))?.value.file.state, 'ready')
  })
  it('never expires permanent files or applies temporary retention to them', async () => {
    for (const scope of [workspace, workflow]) {
      const { row } = await add(scope)
      assert.equal(await repository.markExpired(row.file.fileId, '2100-01-01T00:00:00.000Z'), undefined)
      assert.equal(fileStateAt(row.file, '2100-01-01T00:00:00.000Z'), 'ready')
      assert.deepEqual(applyFileRetention(row.file, 3600, '2100-01-01T00:00:00.000Z'), row.file)
      await assert.rejects(database.pool.query("update files set state='expired' where file_id=$1", [row.file.fileId]))
      await assert.rejects(database.pool.query('update files set expires_at=now() where file_id=$1', [row.file.fileId]))
      assert.equal((await repository.read(row.file.fileId, row.revision.revisionId))?.value.file.state, 'ready')
    }
  })
  it('validates bytes before ready; pending and canceled uploads never download', async () => {
    const { row, requestId } = await allocate(workspace)
    assert.equal((await app.inject({ method: 'GET', url: `${pinned(workspace, row)}/content`, headers: headers() })).statusCode, 409)
    assert.equal((await upload(workspace, requestId, text.subarray(0, 2))).statusCode, 422)
    assert.equal((await finalize(workspace, requestId)).statusCode, 409)
    assert.equal((await upload(workspace, requestId)).statusCode, 200)
    const canceled = await app.inject({ method: 'DELETE', url: `${base(workspace)}/uploads/${requestId}`, headers: headers() })
    assert.equal(canceled.statusCode, 200, canceled.body)
    assert.equal((await finalize(workspace, requestId)).statusCode, 409)
    assert.equal((await upload(workspace, requestId)).statusCode, 409)
    const binaryMarkdown = Buffer.from([0xff, 0x00])
    const invalid = await allocate(workspace, binaryMarkdown)
    const rejected = await upload(workspace, invalid.requestId, binaryMarkdown)
    assert.equal(rejected.statusCode, 415)
    assert.equal(rejected.json().error.code, 'FILE_TYPE_INVALID')
  })
  it('tombstones survive late finalize and cannot be resurrected through SQL', async () => {
    const { row, requestId } = await allocate(workflow)
    assert.equal((await upload(workflow, requestId)).statusCode, 200)
    const entered = rejectableDeferred(), release = rejectableDeferred()
    class DelayedPublication extends FileByteStorage {
      override async finalize(...args: Parameters<FileByteStorage['finalize']>) {
        entered.resolve(); await release.promise; return super.finalize(...args)
      }
    }
    const racing = new FileReferenceService(repository, new DelayedPublication(root, MAX_FILE_BYTES), new PostgresFileReferenceAuthorization(database.pool), commands)
    const finishing = racing.finalize(owner.principal, workflow, requestId)
    const rejected = assert.rejects(finishing, (error: unknown) => error instanceof DomainError && [409, 410].includes(error.status))
    try {
      await entered.promise
      await references.remove(owner.principal, workflow, { commandId: randomUUID(), fileId: row.file.fileId, revisionId: row.revision.revisionId })
    } finally { release.resolve() }
    await rejected
    assert.equal((await repository.read(row.file.fileId, row.revision.revisionId))?.value.file.state, 'removed')
    await assert.rejects(database.pool.query("update files set state='ready' where file_id=$1", [row.file.fileId]))
    await assert.rejects(database.pool.query('delete from files where file_id=$1', [row.file.fileId]))
    assert.equal((await finalize(workflow, requestId)).statusCode, 409)
  })
  it('rechecks revoked grants after receiving bytes and before publication', async () => {
    const delegated = await access.issue({ name: 'Revoked upload', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['workspaces:read', 'workspaces:update'], scope: { workspaceIds: [workspace.workspaceId] } }] })
    const requestId = randomUUID()
    const allocated = await references.allocate(delegated.principal, workspace, { requestId, ...metadata() })
    const entered = rejectableDeferred(), release = rejectableDeferred()
    const source = Readable.from((async function* () {
      yield text.subarray(0, 2); entered.resolve(); await release.promise; yield text.subarray(2)
    })())
    const writing = references.upload(delegated.principal, workspace, requestId, source)
    const rejected = assert.rejects(writing, { code: 'AUTH_REVOKED' })
    try {
      await entered.promise
      await database.pool.query('update management_principals set revoked_at=now() where id=$1', [delegated.principal.id])
    } finally { release.resolve() }
    await rejected
    assert.equal((await repository.read(allocated.value.file.fileId, allocated.value.revision.revisionId))?.value.file.state, 'pending')
  })
  it('keeps removed reference pages navigable through authenticated MCP to a persisted ready revision', async () => {
    const workspaceId = `references-${randomUUID()}`
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Paged references' })])
    const scope: PermanentFileScope = { kind: 'workspace_reference', workspaceId }
    const editor = await access.issue({ name: 'Paged reference editor', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [
        { actions: ['workspaces:read', 'workspaces:update'], scope: { workspaceIds: [workspaceId] } },
      ] })
    const viewer = await access.issue({ name: 'Paged reference reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [
        { actions: ['workspaces:read'], scope: { workspaceIds: [workspaceId] } },
      ] })
    const addReference = async () => {
      const added = await tool(editor.token, 'reference_file_add', { scope,
        upload: { requestId: randomUUID(), ...metadata() }, contentBase64: text.toString('base64') })
      assert.notEqual(added.result.isError, true)
      return FileWithRevisionSchema.parse((decodeMcpToolResult(added.result) as { value: unknown }).value)
    }
    for (let index = 0; index < 25; index++) {
      const row = await addReference()
      const removed = await tool(editor.token, 'reference_file_remove', { scope,
        fileId: row.file.fileId, revisionId: row.revision.revisionId, commandId: randomUUID() })
      assert.notEqual(removed.result.isError, true)
    }
    const ready = await addReference()
    const denied = await tool(foreign.token, 'reference_files_list', { scope, limit: 25 })
    assert.equal(denied.result.isError, true)
    assert.equal(errorCode(denied.result), 'ACCESS_DENIED')
    const first = FilePageSchema.parse(decodeMcpToolResult(
      (await tool(viewer.token, 'reference_files_list', { scope, limit: 25 })).result))
    assert.equal(first.items.length, 25)
    assert.ok(first.items.every(row => row.file.state === 'removed'))
    assert.ok(first.pageInfo.nextCursor)
    const second = FilePageSchema.parse(decodeMcpToolResult((await tool(viewer.token, 'reference_files_list',
      { scope, limit: 25, cursor: first.pageInfo.nextCursor })).result))
    assert.deepEqual(second.items, [ready])
    const downloaded = await tool(viewer.token, 'reference_file_read', { scope,
      fileId: ready.file.fileId, revisionId: ready.revision.revisionId })
    const value = FileReferenceReadResultSchema.parse(decodeMcpToolResult(downloaded.result)).value
    assert.equal(value.status, 'ready')
    if (value.status !== 'ready') throw new Error('Ready reference required')
    assert.deepEqual(Buffer.from(value.contentBase64, 'base64'), text)
    const refreshed = new FileReferenceService(new PostgresFileRepository(database.pool),
      new FileByteStorage(root, MAX_FILE_BYTES), new PostgresFileReferenceAuthorization(database.pool), commands)
    assert.deepEqual(await refreshed.list(viewer.principal, scope, { limit: 25, cursor: first.pageInfo.nextCursor }), second)
  })

  for (const kind of ['workspace_reference', 'workflow_reference'] as const) it(`MCP ${kind}: add/list/range read/remove/readback share HTTP persistence, retries and audit`, async () => {
    const scope = kind === 'workspace_reference' ? workspace : workflow
    const capabilities = await tool(owner.token, 'operator_get_capabilities', { detail: 'full' })
    assert.ok((decodeMcpToolResult(capabilities.result) as { runtimeLimits: { feature: string; detail: string }[] }).runtimeLimits
      .some((limit) => limit.feature === 'permanent_reference_files' && limit.detail.includes('tools/list')))
    const args = { scope, upload: { requestId: randomUUID(), ...metadata() }, contentBase64: text.toString('base64') }
    const added = await tool(owner.token, 'reference_file_add', args)
    assert.equal(added.result.isError, undefined, JSON.stringify(added))
    const result = decodeMcpToolResult(added.result) as { value: FileWithRevision; replayed: boolean }
    const row = FileWithRevisionSchema.parse(result.value); assert.equal(row.file.state, 'ready')
    const replay = await tool(owner.token, 'reference_file_add', args)
    assert.equal((decodeMcpToolResult(replay.result) as { replayed: boolean }).replayed, true)
    const list = await tool(reader.token, 'reference_files_list', { scope })
    assert.ok(FilePageSchema.parse(decodeMcpToolResult(list.result)).items.some((item) => item.file.fileId === row.file.fileId))
    const readInput = { scope, fileId: row.file.fileId, revisionId: row.revision.revisionId, offset: 2, length: 8 }
    const read = await tool(reader.token, 'reference_file_read', readInput)
    const value = (decodeMcpToolResult(read.result) as { value: { status: string; contentBase64: string; byteLength: number } }).value
    assert.equal(value.status, 'ready'); assert.equal(value.byteLength, 8)
    assert.deepEqual(Buffer.from(value.contentBase64, 'base64'), text.subarray(2, 10))
    const http = await app.inject({ method: 'GET', url: `${pinned(scope, row)}/content`, headers: headers(reader.token) })
    assert.deepEqual(http.rawPayload, text)
    const removeInput = { scope, fileId: row.file.fileId, revisionId: row.revision.revisionId, commandId: randomUUID() }
    const removed = await tool(owner.token, 'reference_file_remove', removeInput)
    assert.equal((decodeMcpToolResult(removed.result) as { value: FileWithRevision }).value.file.state, 'removed')
    assert.equal((decodeMcpToolResult((await tool(owner.token, 'reference_file_remove', removeInput)).result) as { replayed: boolean }).replayed, true)
    const gone = decodeMcpToolResult((await tool(reader.token, 'reference_file_read', readInput)).result) as { value: { status: string; reason: string } }
    assert.deepEqual(gone.value.status, 'unavailable'); assert.equal(gone.value.reason, 'removed')
    const audit = await database.pool.query<{ action: string }>("select action from management_audit where source='mcp' and target_key=$1", [`file:${row.file.fileId}`])
    assert.ok(audit.rows.some((item) => item.action === 'reference_file.add'))
    assert.equal(audit.rows.filter((item) => item.action === 'reference_file.remove').length, 1)
    const refreshed = new FileReferenceService(new PostgresFileRepository(database.pool), new FileByteStorage(root, MAX_FILE_BYTES), new PostgresFileReferenceAuthorization(database.pool), commands)
    assert.equal((await refreshed.read(reader.principal, scope, readInputWithoutScope(readInput))).status, 'unavailable')
  })
  function readInputWithoutScope(input: { fileId: string; revisionId: string; offset: number; length: number }) {
    return { fileId: input.fileId, revisionId: input.revisionId, offset: input.offset, length: input.length }
  }
  for (const kind of ['workspace_reference', 'workflow_reference'] as const) it(`MCP ${kind}: denies read-only writes and foreign reads, including direct unlisted tool calls`, async () => {
    const scope = kind === 'workspace_reference' ? workspace : workflow
    const listed = await rpc(reader.token, 'tools/list', {})
    const names = listed.result.tools?.map((entry) => entry.name) ?? []
    assert.ok(names.includes('reference_files_list')); assert.ok(names.includes('reference_file_read'))
    assert.equal(names.includes('reference_file_add'), false); assert.equal(names.includes('reference_file_remove'), false)
    const { row } = await add(scope)
    const args = { scope, upload: { requestId: randomUUID(), ...metadata() }, contentBase64: text.toString('base64') }
    const denied = await tool(reader.token, 'reference_file_add', args)
    assert.equal(denied.result.isError, true); assert.equal(errorCode(denied.result), 'ACCESS_DENIED')
    const remove = await tool(reader.token, 'reference_file_remove', { scope, fileId: row.file.fileId, revisionId: row.revision.revisionId, commandId: randomUUID() })
    assert.equal(errorCode(remove.result), 'ACCESS_DENIED')
    const other = await tool(foreign.token, 'reference_file_read', { scope, fileId: row.file.fileId, revisionId: row.revision.revisionId })
    assert.equal(errorCode(other.result), 'ACCESS_DENIED')
    assert.equal((await repository.read(row.file.fileId, row.revision.revisionId))?.value.file.state, 'ready')
    const audit = await database.pool.query("select 1 from management_audit where principal_id=$1 and source='mcp' and outcome='denied' and action='reference_file_add'", [reader.principal.id])
    assert.ok(audit.rowCount)
  })
  it('MCP accepts a full-size reference and limits byte reads to 64 KiB', async () => {
    const bytes = Buffer.alloc(MAX_FILE_BYTES, 97)
    const result = await tool(owner.token, 'reference_file_add', { scope: workflow, upload: { requestId: randomUUID(), ...metadata(bytes) }, contentBase64: bytes.toString('base64') })
    assert.equal(result.result.isError, undefined, JSON.stringify(result))
    const row = FileWithRevisionSchema.parse((decodeMcpToolResult(result.result) as { value: unknown }).value)
    assert.equal(row.revision.byteSize, MAX_FILE_BYTES)
    const read = await tool(reader.token, 'reference_file_read', { scope: workflow, fileId: row.file.fileId, revisionId: row.revision.revisionId })
    const value = (decodeMcpToolResult(read.result) as { value: { byteLength: number; eof: boolean; contentBase64: string } }).value
    assert.equal(value.byteLength, MAX_FILE_READ_BYTES); assert.equal(value.eof, false)
    assert.deepEqual(Buffer.from(value.contentBase64, 'base64'), bytes.subarray(0, MAX_FILE_READ_BYTES))
  }, 60_000)
})
