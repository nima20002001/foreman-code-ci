import type pg from 'pg'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import Fastify, { type FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { workflowArtifactTransferManifestDigest } from '@foreman-code/contracts/workflow-artifact-transfer-node'
import type { AcceptedArtifactPublication, DistributedArtifactPublicationService } from '../../files/distributed/publication.js'
import type { FileQuery } from '../../files/repository.js'
import type { ArtifactEdgeService } from '../../files/distributed/edges.js'
import { registerDistributedArtifacts } from '../../files/distributed/adapters.js'
import { lockActiveWorkerPrincipal } from '../../access/workerLifecycle.js'
import { readDispatchIntent, readAcceptedPlacement } from '../../placement/persistence.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { transferContextForBinding } from '../../byte-transfer/carrier.js'
import { DomainError } from '../../errors.js'
import { createWorkflowArtifactReceiver } from './workflowArtifactReceiver.js'

vi.mock('../../access/workerLifecycle.js', () => ({ lockActiveWorkerPrincipal: vi.fn() }))
vi.mock('../../placement/persistence.js', () => ({ readDispatchIntent: vi.fn(), readAcceptedPlacement: vi.fn() }))
vi.mock('./persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
const roots: string[] = [], closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const request = (token = 'unit-workflow') => ({ headers: { authorization: `Bearer ${token}` } }) as FastifyRequest

// Unit SQL/authentication boundaries; the receiver uses real private file storage.
// These fixtures cannot authorize a production worker or establish physical acceptance.
async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'workflow-artifacts-')); roots.push(root)
  const digest = 'a'.repeat(64), mainId = randomUUID(), deviceId = randomUUID(), installation = randomUUID()
  const original: DeviceSessionBinding = { mainId, deviceId, workerInstallationId: installation, keyRevision: 1,
    authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 7 }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId: installation, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/original/project', canonicalCwd: '/original/project', managedRuntimeRoot: '/original/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { kind: 'pending', approvedSourceId: randomUUID(), snapshotId: randomUUID(), rootId: randomUUID(), bindingRevision: 1,
      revisionId: 'source', manifestDigest: digest, materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest,
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID(), occurrenceId: null,
    occurrenceIndex: 0, technicalAttempt: 1, inputDigest: `sha256:${digest}`, owner: { grantId: 'original-grant', epoch: '1' } })
  const attempt = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', nodeId: 'node', executionId: intent.executionId,
    attemptId: intent.attemptId, placementHash: placement.bindingHash }
  const worker: ManagementPrincipal = { id: 'worker-lease', name: 'unit worker', audience: 'worker', agentId: 'agent',
    grants: [{ actions: ['interactions:read'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'], runIds: ['run'] } }],
    expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null }
  const accepted: AcceptedArtifactPublication = { attempt, transferContext: transferContextForBinding(original),
    context: { ownerPrincipalId: 'original-run-owner', scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'original-context',
      workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', executionId: intent.executionId, agentId: 'agent' } },
    nativeSessionId: 'original-session', turnId: 'original-turn', allowMutation: true, allowedTools: ['files.read', 'files.publish_result'] } }
  const row = { execution_id: intent.executionId, run_id: 'run', agent_id: 'agent', workspace_id: 'workspace', workflow_id: 'workflow',
    purpose: 'workflow', authorization_principal_id: 'original-run-owner', stopped: false, cleanup: false }
  type Receipt = { principal_id: string; input_hash: string; target_key: string; result: unknown }
  const state = { current: original as DeviceSessionBinding | undefined, revoked: false, ownerRevoked: false, grantLive: true,
    contextAvailable: true, receipts: new Map<string, Receipt>(), audits: 0, calls: [] as string[] }
  let backup: Map<string, Receipt> | undefined
  const query = vi.fn(async (text: string, args: unknown[] = []) => {
    state.calls.push(text); let rows: unknown[] = []
    if (text === 'begin') backup = structuredClone(state.receipts)
    else if (text === 'rollback' && backup) state.receipts = backup
    else if (text.includes('from management_principals')) rows = state.revoked ? [] : [{ id: worker.id }]
    else if (text.includes('from worker_credential_bindings b join harness_executions e')) rows = [row]
    else if (text.startsWith('select principal_id, input_hash, target_key')) {
      const principals = args[0] as string[]
      rows = principals.flatMap(principal => {
        const found = state.receipts.get(JSON.stringify([principal, args[1], args[2]]))
        return found ? [found] : []
      })
    } else if (text.startsWith('insert into management_command_receipts')) {
      state.receipts.set(JSON.stringify(args.slice(0, 3)), { principal_id: args[0] as string, target_key: args[3] as string,
        input_hash: args[4] as string, result: JSON.parse(args[5] as string) })
    } else if (text.includes("result->'intent'->>'transferId'")) rows = [...state.receipts.values()].filter(value => {
      const result = value.result as { intent: { transferId: string } }; return result.intent.transferId === args[1]
    })
    else if (text.startsWith('insert into management_audit') && text.includes("'succeeded'")) state.audits++
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
  })
  const sql = { query, release: vi.fn() } as unknown as pg.PoolClient
  const pool = { query, connect: async () => sql } as unknown as pg.Pool
  vi.mocked(lockActiveWorkerPrincipal).mockImplementation(async (client, snapshot) => {
    void client
    if (state.revoked || snapshot.id !== worker.id || Date.parse(worker.expiresAt) <= Date.now()) throw new DomainError('AUTH_REVOKED', 'unit revoked', 401)
    return worker
  })
  vi.mocked(readDispatchIntent).mockImplementation(async () => intent)
  vi.mocked(readReconciledDispatchIntent).mockImplementation(async () => intent)
  vi.mocked(readAcceptedPlacement).mockImplementation(async () => placement)
  const access = { authenticate: vi.fn(async (token: string | undefined, audience: unknown) => {
    if (token !== 'unit-workflow' || audience !== 'worker' || state.revoked) throw new DomainError('AUTH_INVALID', 'unit worker required', 401)
    return worker
  }) }
  const authorize = vi.fn(async (value: AcceptedArtifactPublication, client: FileQuery) => {
    await client.query('select 1')
    if (state.ownerRevoked) throw new DomainError('AUTH_REVOKED', 'unit owner revoked', 401)
    return { context: value.context, principal: { ...worker, id: 'original-run-owner', audience: 'operator' as const }, binding: 'unit-original' }
  })
  const resolve = async (_currentAttempt: typeof attempt, context: typeof accepted.transferContext, client?: FileQuery) => {
    if (!client) throw new Error('Unit publication requires its transaction client')
    if (!state.contextAvailable) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'unit absent', 409)
    const publication = { ...structuredClone(accepted), transferContext: context }
    return { accepted: publication, authorized: await authorize(publication, client) }
  }
  const authority = { resolveWorkflowContext: vi.fn(async (...args: Parameters<typeof resolve>) => (await resolve(...args)).accepted),
    resolveAuthorizedWorkflowContext: vi.fn(resolve), authorize }
  const fence = { assertCurrent: vi.fn(async current => {
    if (!state.grantLive || !isSame(current, attempt) || state.ownerRevoked) throw new DomainError('FILE_EDGE_DENIED', 'unit grant revoked', 403)
  }) } satisfies Parameters<typeof createWorkflowArtifactReceiver>[0]['fence']
  const endpoint = { currentBinding: vi.fn(() => state.current) }
  const create = () => createWorkflowArtifactReceiver({ mainId, pool, stagingRoot: root, access, authority, fence, endpoint })
  const receiver = create(); closers.push(receiver.close)
  const bytes = Buffer.from('original immutable artifact'), declaration = { commandId: 'original-output-command', sha256: hash(bytes), byteSize: bytes.length }
  const frame = () => ({ binding: state.current!, signal: new AbortController().signal })
  const send = async (id: string, method: 'start' | 'status' | 'finish' | 'cancel') => receiver.extension.handle!({ method, transferId: id }, frame())
  const append = async (id: string, bytesInput = bytes, offset = 0, sha256 = hash(bytesInput)) => receiver.extension.handle!(
    { method: 'append', transferId: id, offset, sha256, byteLength: bytesInput.length }, { ...frame(), bytes: bytesInput })
  return { root, placement, intent, attempt, accepted, worker, row, state, access, authority, fence, endpoint,
    receiver, create, bytes, declaration, send, append, frame }
}
function isSame(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b) }

describe('accepted workflow artifact receiver', () => {
  it('loads the locked execution graph once per authorization and rechecks across byte writes', async () => {
    const t = await fixture()
    const intent = await t.receiver.admit(request(), t.declaration)
    await t.send(intent.transferId, 'start')
    vi.mocked(readDispatchIntent).mockClear()
    t.authority.authorize.mockClear()
    await t.append(intent.transferId)
    // Routing plus the checks before and after the byte write each need one loaded graph.
    expect(readDispatchIntent).toHaveBeenCalledTimes(3)
    expect(t.authority.authorize).toHaveBeenCalledTimes(3)
    t.state.revoked = true
    await expect(t.append(intent.transferId)).rejects.toThrow()
  })

  it('keeps transfer operations within statement ceilings while reauthorizing every write boundary', async () => {
    const t = await fixture()
    const measure = async <T>(work: () => Promise<T>, ceiling: number) => {
      const before = t.state.calls.length
      const value = await work()
      expect(t.state.calls.length - before).toBeLessThanOrEqual(ceiling)
      return value
    }
    const intent = await measure(() => t.receiver.admit(request(), t.declaration), 19)
    await measure(() => t.send(intent.transferId, 'start'), 25)
    await measure(() => t.append(intent.transferId), 19)
    await measure(() => t.append(intent.transferId), 19)
    const receipt = await measure(() => t.send(intent.transferId, 'finish'), 19)
    expect((await measure(() => t.send(intent.transferId, 'finish'), 19)).payload).toEqual(receipt.payload)
    expect(await measure(() => t.receiver.admit(request(), t.declaration), 17)).toEqual(intent)
    expect(t.state.receipts.size).toBe(1)
    expect(t.state.audits).toBe(1)
  })

  it('admits only derived original pins, immutable manifest and worker identity through the command ledger', async () => {
    const t = await fixture(), admitted = await t.receiver.admit(request(), t.declaration)
    if (!('rootId' in t.placement.source)) throw new Error('unit pending source required')
    expect(admitted).toMatchObject({ executionId: t.intent.executionId, attemptId: t.intent.attemptId, operationId: t.intent.operationId,
      placementHash: t.placement.bindingHash, rootId: t.placement.source.rootId, direction: 'to-main', byteClass: 'artifact',
      manifestDigest: workflowArtifactTransferManifestDigest(t.declaration), connectionEpoch: t.state.current!.connectionEpoch })
    expect(admitted.manifestDigest).not.toBe(admitted.sha256)
    expect(t.access.authenticate).toHaveBeenCalledWith('unit-workflow', 'worker')
    const persisted = [...t.state.receipts.values()][0]!
    expect(persisted.principal_id).toBe(t.worker.id); expect(persisted.result).toMatchObject({ workerPrincipalId: t.worker.id })
    expect(JSON.stringify(persisted)).not.toContain('unit-workflow'); expect(t.state.audits).toBe(1)
    expect(await t.receiver.admit(request(), t.declaration, 'mcp')).toEqual(admitted); expect(t.state.audits).toBe(1)
    await expect(t.receiver.admit(request(), { ...t.declaration, sha256: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })
  it('routes persisted artifact IDs even after revocation and admits only the genuine forwarded MCP worker bearer', async () => {
    const t = await fixture(), intent = await t.receiver.admit(request(), t.declaration, 'mcp')
    expect(t.access.authenticate).toHaveBeenCalledWith('unit-workflow', 'worker')
    expect(await t.receiver.ownsTransfer(intent.transferId)).toBe(true)
    expect(await t.receiver.ownsTransfer(randomUUID())).toBe(false)
    t.state.revoked = true
    expect(await t.receiver.ownsTransfer(intent.transferId)).toBe(true)
    await expect(t.send(intent.transferId, 'start')).rejects.toThrow()
    t.state.revoked = false
    t.worker.audience = 'operator'
    await expect(t.receiver.admit(request(), { ...t.declaration, commandId: 'operator-must-not-convert' }, 'mcp')).rejects.toThrow()
    expect(t.state.receipts.size).toBe(1)
  })
  it('receives genuine byte chunks, verifies the whole object and reads the same receipt after lost finish ACK and cold reconstruction', async () => {
    const t = await fixture(), intent = await t.receiver.admit(request(), t.declaration)
    await t.send(intent.transferId, 'start'); await t.append(intent.transferId)
    const receipt = (await t.send(intent.transferId, 'finish')).payload
    expect((await t.send(intent.transferId, 'finish')).payload).toEqual(receipt)
    const context = transferContextForBinding(t.state.current!)
    expect(await t.receiver.reader.resolveVerifiedReceipt(intent.transferId, context)).toEqual(receipt)
    await t.receiver.close(); const cold = t.create(); closers.push(cold.close)
    const verified = await cold.reader.resolveVerifiedReceipt(intent.transferId, context)
    expect(verified).toEqual(receipt)
    const stream = await cold.reader.openVerified(verified, context), chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(t.bytes)
    expect(await cold.admit(request(), t.declaration)).toEqual(intent); expect(t.state.audits).toBe(1)
  })
  it('resumes durable offsets on the current opaque epoch without replacing original transfer identity', async () => {
    const t = await fixture(), intent = await t.receiver.admit(request(), t.declaration), previous = t.state.current!
    await t.send(intent.transferId, 'start'); await t.append(intent.transferId, t.bytes.subarray(0, 5))
    t.state.current = { ...previous, connectionEpoch: randomUUID(), bootId: randomUUID() }
    await expect(t.receiver.reader.status(intent.transferId, transferContextForBinding(previous))).rejects.toThrow()
    expect((await t.send(intent.transferId, 'status')).payload).toMatchObject({ durableOffset: 5 })
    await t.append(intent.transferId, t.bytes.subarray(5), 5)
    const result = (await t.send(intent.transferId, 'finish')).payload as { intent: unknown }
    expect(result.intent).toEqual(intent)
    expect(await t.receiver.admit(request(), t.declaration)).toEqual(intent)
  })
  it.each(['reviewer', 'operator', 'scope', 'stopped', 'cleanup', 'revoked', 'grant', 'generation', 'device', 'installation', 'key', 'context', 'readonly'] as const)(
    'denies %s authority without allocation', async field => {
      const t = await fixture()
      if (field === 'reviewer') t.row.purpose = 'reviewer'
      if (field === 'operator') t.worker.audience = 'operator'
      if (field === 'scope') t.worker.grants[0]!.scope.runIds = ['different-run']
      if (field === 'stopped') t.row.stopped = true
      if (field === 'cleanup') t.row.cleanup = true
      if (field === 'revoked') t.state.revoked = true
      if (field === 'grant') t.state.grantLive = false
      if (field === 'generation') t.fence.assertCurrent.mockImplementationOnce(async () => { t.state.current!.connectionGeneration++ })
      if (field === 'device') t.state.current!.deviceId = randomUUID()
      if (field === 'installation') t.state.current!.workerInstallationId = randomUUID()
      if (field === 'key') t.state.current!.keyRevision++
      if (field === 'context') t.state.contextAvailable = false
      if (field === 'readonly') { t.accepted.context.allowMutation = false; t.accepted.context.allowedTools = ['files.read'] }
      await expect(t.receiver.admit(request(), t.declaration)).rejects.toThrow()
      expect(t.state.receipts.size).toBe(0); expect(t.state.audits).toBe(0)
    })
  it.each(['execution', 'attempt', 'operation', 'placement', 'root', 'context', 'principal', 'manifest', 'class'] as const)(
    'rejects changed original %s on persisted readback', async field => {
      const t = await fixture(), intent = await t.receiver.admit(request(), t.declaration)
      const stored = [...t.state.receipts.values()][0]!.result as { workerPrincipalId: string; intent: typeof intent }
      if (field === 'execution') stored.intent.executionId = randomUUID()
      if (field === 'attempt') stored.intent.attemptId = randomUUID()
      if (field === 'operation') stored.intent.operationId = randomUUID()
      if (field === 'placement') stored.intent.placementHash = 'b'.repeat(64)
      if (field === 'root') stored.intent.rootId = randomUUID()
      if (field === 'context') t.accepted.context.turnId = 'replacement-turn'
      if (field === 'principal') stored.workerPrincipalId = 'different-worker'
      if (field === 'manifest') stored.intent.manifestDigest = 'b'.repeat(64)
      if (field === 'class') stored.intent.byteClass = 'source'
      await expect(t.send(intent.transferId, 'start')).rejects.toThrow()
    })
  it('reauthorizes append, verified reads and exact command retries after revocation', async () => {
    const t = await fixture(), intent = await t.receiver.admit(request(), t.declaration)
    await t.send(intent.transferId, 'start'); t.state.revoked = true
    await expect(t.append(intent.transferId)).rejects.toThrow()
    await expect(t.receiver.admit(request(), t.declaration)).rejects.toThrow()
    t.state.revoked = false; await t.append(intent.transferId); await t.send(intent.transferId, 'finish')
    const context = transferContextForBinding(t.state.current!), receipt = await t.receiver.reader.resolveVerifiedReceipt(intent.transferId, context)
    t.state.ownerRevoked = true
    await expect(t.receiver.reader.resolveVerifiedReceipt(intent.transferId, context)).rejects.toThrow()
    await expect(t.receiver.reader.openVerified(receipt, context)).rejects.toThrow()
  })
  it('rechecks worker revocation after context resolution and does not combine separate scope grants', async () => {
    const t = await fixture()
    t.authority.authorize.mockImplementationOnce(async value => {
      t.state.revoked = true
      return { context: value.context, principal: { ...t.worker, id: 'original-run-owner', audience: 'operator' }, binding: 'unit-original' }
    })
    await expect(t.receiver.admit(request(), t.declaration)).rejects.toThrow()
    expect(t.state.receipts.size).toBe(0)
    t.state.revoked = false; t.worker.grants = [
      { actions: ['interactions:read'], scope: { workspaceIds: ['workspace'], workflowIds: ['different'], runIds: ['run'] } },
      { actions: ['interactions:read'], scope: { workspaceIds: ['different'], workflowIds: ['workflow'], runIds: ['run'] } },
    ]
    await expect(t.receiver.admit(request(), t.declaration)).rejects.toThrow()
  })
  it('rejects caller paths or context and oversized declarations before command admission', async () => {
    const t = await fixture()
    await expect(t.receiver.admit(request(), { ...t.declaration, destinationPath: '/unowned' } as typeof t.declaration)).rejects.toThrow()
    await expect(t.receiver.admit(request(), { ...t.declaration, byteSize: 128 * 1024 * 1024 })).rejects.toThrow()
    expect(t.state.receipts.size).toBe(0); expect(t.access.authenticate).not.toHaveBeenCalled()
  })
  it('rejects incomplete, corrupt, changed chunk and unknown transfer without a verified receipt', async () => {
    const t = await fixture(), intent = await t.receiver.admit(request(), t.declaration)
    await t.send(intent.transferId, 'start'); await t.append(intent.transferId, t.bytes.subarray(0, 5))
    await expect(t.send(intent.transferId, 'finish')).rejects.toThrow('integrity')
    await expect(t.append(intent.transferId, t.bytes.subarray(5), 5, '0'.repeat(64))).rejects.toThrow()
    await expect(t.receiver.reader.resolveVerifiedReceipt(intent.transferId, transferContextForBinding(t.state.current!))).rejects.toThrow()
    await expect(t.send(randomUUID(), 'start')).rejects.toThrow()
    await t.append(intent.transferId, t.bytes.subarray(5), 5); await t.send(intent.transferId, 'finish')
    const context = transferContextForBinding(t.state.current!), receipt = await t.receiver.reader.resolveVerifiedReceipt(intent.transferId, context)
    await writeFile(join(t.root, `${intent.transferId}.part`), Buffer.alloc(t.bytes.length, 9), { mode: 0o600 })
    await expect(t.receiver.reader.openVerified(receipt, context)).rejects.toThrow('corrupted')
  })
  it('uses the same server-derived authenticated consumer through HTTP/MCP and denies cookies/Operator/reviewer credentials', async () => {
    const t = await fixture(), app = Fastify(), readAccepted = vi.fn(async (...args: unknown[]) => {
      void args; return { status: 'unavailable' as const, ref: { fileId: 'unit-file', revisionId: 'unit-revision' }, reason: 'not_found' }
    })
    app.setErrorHandler((error, _request, reply) => { void reply.code(error instanceof DomainError ? error.status : 500).send({ error: error instanceof DomainError ? error.code : 'ERROR' }) })
    registerDistributedArtifacts(app, { readAccepted } as unknown as ArtifactEdgeService, {} as DistributedArtifactPublicationService, t.receiver.authorization)
    const input = { edgeId: randomUUID(), offset: 0, length: 4 }, headers = { authorization: 'Bearer unit-workflow' }
    try {
      expect((await app.inject({ method: 'POST', url: '/api/artifact-inputs/read', headers, payload: input })).statusCode).toBe(200)
      const mcp = await app.inject({ method: 'POST', url: '/mcp/artifact-inputs', headers: { ...headers, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'files.read_edge_input', arguments: input } } })
      expect(mcp.statusCode).toBe(200)
      expect(readAccepted.mock.calls).toHaveLength(2)
      for (const call of readAccepted.mock.calls) expect(call.slice(1, 3)).toEqual([t.attempt, {
        principalId: 'original-run-owner', grantId: 'original-grant', grantRevision: '1' }])
      for (const url of ['/api/artifact-inputs/read', '/mcp/artifact-inputs']) {
        expect((await app.inject({ method: 'POST', url, headers: { cookie: 'browser_session=unit' }, payload: input })).statusCode).toBe(401)
        expect((await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer unit-operator' }, payload: input })).statusCode).toBe(401)
        t.row.purpose = 'reviewer'
        expect((await app.inject({ method: 'POST', url, headers, payload: input })).statusCode).toBe(403)
      }
      expect(readAccepted).toHaveBeenCalledTimes(2)
    } finally { await app.close() }
  })
})
