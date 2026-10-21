import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type HarnessExecution } from '@foreman-code/contracts'
import type { ArtifactAttempt, ArtifactEdgeBinding } from '@foreman-code/contracts/artifact-edges'
import type { VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import type { FileQuery } from '../../files/repository.js'
import type { AcceptedArtifactPublication } from '../../files/distributed/publication.js'
import { bindingIdentity } from '../../files/tools/context.js'
import { codexChatFileTools } from '../../harnesses/codexFiles/declarations.js'
import { readDispatchIntent, readAcceptedPlacement, readNativePlacement } from '../../placement/persistence.js'
import { readReconciledDispatchIntent } from './persistence.js'
import { assertDeviceHostInstallation } from '../../devices/hostAuthorization.js'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { readNativeArtifactOutput } from './nativeArtifactOutputPostgres.js'
import { PostgresArtifactPublicationAuthority, PostgresAcceptedArtifactAttemptFence } from './nativeArtifactAuthority.js'
import { completeResultRepair } from './workflowRepair.test-support.js'

vi.mock('../../placement/persistence.js', () => ({ readDispatchIntent: vi.fn(), readAcceptedPlacement: vi.fn(), readNativePlacement: vi.fn() }))
vi.mock('./persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
vi.mock('../../devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: vi.fn() }))
vi.mock('./nativeArtifactOutputPostgres.js', () => ({ readNativeArtifactOutput: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
function fixture() {
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID(), digest = 'a'.repeat(64)
  const executionId = randomUUID(), attemptId = randomUUID(), operationId = randomUUID(), rootId = randomUUID()
  const configuration: AgentConfigurationVersion = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1,
    prompt: { system: 'accepted' }, assignedSkills: [], harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' },
    contentHash: 'sha256:accepted', createdAt: '2026-10-01T00:00:00.000Z' }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest,
      rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
    source: { kind: 'pending', approvedSourceId: randomUUID(), snapshotId: randomUUID(), rootId, bindingRevision: 1, revisionId: 'source', manifestDigest: digest, materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest,
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [], artifactOutputs: { version: 1, outputKeys: ['result'] } } })
  const intent = deriveDispatch(placement, { executionId, attemptId, operationId, occurrenceId: null,
    occurrenceIndex: 0, technicalAttempt: 1, inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } })
  const execution: HarnessExecution = { id: executionId, runId: 'run', workflowNodeId: 'node', agentId: 'agent', agentConfigurationVersionId: 'configuration',
    attempt: 1, nativeSessionId: 'original-session', workingDirectory: '/original/worktree', runtimeDirectory: '/original/runtime',
    state: 'running', input: {}, createdAt: '2026-10-01T00:00:00.000Z' }
  const attempt: ArtifactAttempt = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', nodeId: 'node', executionId,
    attemptId, placementHash: placement.bindingHash }
  const transferContext = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID() }
  const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent, connection: { mainId, deviceId, workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, bootId: transferContext.bootId, connectionGeneration: 1 }, workerIncarnationId: randomUUID(),
    sequence: 2, phase: 'running', native: { sessionId: 'original-session', turnId: 'original-turn', processIdentityDigest: digest },
    entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [] }
  const accepted: AcceptedArtifactPublication = { attempt, transferContext, context: { ownerPrincipalId: 'run-owner',
    scope: { kind: 'temporary', chat: { kind: 'agent', conversationId: 'original-conversation', workspaceId: 'workspace', workflowId: 'workflow',
      runId: 'run', executionId, agentId: 'agent' } }, nativeSessionId: 'original-session', turnId: 'original-turn',
    allowMutation: true, allowedTools: codexChatFileTools(configuration.harness as typeof DEFAULT_HARNESS_DEFAULTS.codex) } }
  const state = { execution, configuration, receipt, principalId: 'run-owner', callerAllowed: false, conversationAvailable: true,
    conversationCount: 1, revoked: false, writeAllowed: true, grantLive: true, stopped: false, nativeSessionId: 'original-session',
    messages: false, cleanup: false, statements: 0, nativeReads: 0, conversationWrites: 0,
    conversationLookup: [] as unknown[], callerChecks: [] as unknown[][], audits: [] as unknown[][] }
  const query = vi.fn(async (text: string, args: unknown[] = []) => {
    state.statements += 1
    let rows: unknown[] = []
    if (/execution_native_sessions|remote_execution_receipts|operator_conversations/.test(text)) state.nativeReads += 1
    if (/insert|update operator_conversations/i.test(text)) state.conversationWrites += 1
    if (text.includes('insert into management_audit')) state.audits.push(args)
    if (text.includes('from operator_conversations') && args.length === 9) state.conversationLookup = args
    if (text.includes('from run_authority_principals')) state.callerChecks.push(args)
    if (text.includes('from harness_executions e join runs')) rows = [{ execution: state.execution, configuration: state.configuration,
      workspace_id: 'workspace', workflow_id: 'workflow', authorization_principal_id: state.principalId, stopped: state.stopped }]
    else if (text.includes('from runs r join harness_executions')) rows = [{ workspace_id: 'workspace', workflow_id: 'workflow' }]
    else if (text.includes('from run_cleanup_intents')) rows = state.cleanup ? [{}] : []
    else if (text.includes('from management_principals')) rows = [{ id: args[0], name: 'accepted owner', audience: 'operator',
      grants: [{ actions: ['agent_chat:read', ...(state.writeAllowed ? ['agent_chat:write'] : [])], scope: {} }],
      expires_at: new Date('2099-01-01T00:00:00.000Z'), revoked_at: state.revoked ? new Date() : null, delegated_from: null }]
    else if (text.includes('from execution_dispatch_owner_grants')) rows = state.grantLive ? [{}] : []
    else if (text.includes('from run_authority_principals')) rows = state.callerAllowed ? [{}] : []
    else if (text.includes('from operator_conversations')) rows = state.conversationAvailable
      ? Array.from({ length: state.conversationCount }, () => ({ id: 'original-conversation' })) : []
    else if (text.includes('from remote_dispatch_origins')) rows = [{ connection: state.receipt.connection }]
    else if (text.includes('from execution_native_sessions')) rows = [{ reference: { harness: 'codex', providerVersion: '0.154', nativeSessionId: state.nativeSessionId } }]
    else if (text.includes('from remote_execution_receipts')) rows = [{ receipt: state.receipt }]
    else if (text.includes('from operator_conversation_turns')) rows = state.messages ? [{}] : []
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
  })
  const sql = { query } as unknown as FileQuery
  vi.mocked(readDispatchIntent).mockImplementation(async client => { await client.query('select 1'); return intent })
  vi.mocked(readReconciledDispatchIntent).mockImplementation(async client => { await client.query('select 1'); return intent })
  vi.mocked(readAcceptedPlacement).mockImplementation(async client => { await client.query('select 1'); return placement })
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ keyRevision: 1, authorizationRevision: 1 } as NonNullable<Awaited<ReturnType<typeof assertDeviceHostInstallation>>>)
  vi.mocked(readNativePlacement).mockResolvedValue({ acceptedBindingHash: placement.bindingHash } as NativeExecutionPlacement)
  const ports = { locations: { revalidateRunAuthorization: vi.fn(async (_principal: string, _workspace: string, _workflow: string, client: FileQuery) => {
    await client.query('select 1')
  }) }, producer: { assertPinsCurrent: vi.fn(async (client: FileQuery) => { await client.query('select 1') }) } }
  const authority = new PostgresArtifactPublicationAuthority(mainId, {} as pg.Pool, ports)
  const fence = new PostgresAcceptedArtifactAttemptFence(mainId, ports)
  const declarationsRequest = { version: 1 as const, operation: 'worker-mcp.authorize-native-output-declarations' as const, intent, placement,
    applicationAccess: { kind: 'scoped-worker-mcp' as const, token: 'original-worker-bearer', executionId, agentId: 'agent',
      operationId, attemptId, bindingHash: intent.bindingHash } }
  return { mainId, placement, intent, execution, attempt, accepted, state, sql, ports, authority, fence, declarationsRequest }
}
describe('original accepted artifact authority', () => {
  it('reads an earlier publishing context through the repair journal while keeping mutation authority on the active turn', async () => {
    const t = fixture()
    completeResultRepair(t.state.receipt, 'corrective-turn')
    const original = structuredClone(t.accepted)
    await expect(t.authority.authorize(original, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    const caller = await t.authority.authorizePublication(original, t.sql)
    expect(caller.context).toEqual(original.context)
    expect(t.accepted).toEqual(original)
    t.state.receipt.nativeTurnRetries = []
    await expect(t.authority.authorizePublication(original, t.sql))
      .rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
  })
  it.each(['revoked', 'foreign-turn', 'foreign-session', 'readonly-change'] as const)(
    'keeps publication read authority checks for %s after a correction', async reason => {
      const t = fixture()
      completeResultRepair(t.state.receipt, 'corrective-turn')
      if (reason === 'revoked') t.state.revoked = true
      if (reason === 'foreign-turn') t.accepted.context.turnId = 'unrecorded-turn'
      if (reason === 'foreign-session') t.accepted.context.nativeSessionId = 'foreign-session'
      if (reason === 'readonly-change') t.state.configuration.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'read-only' }
      const code = reason === 'revoked' ? 'AUTH_REVOKED' : 'NATIVE_ARTIFACT_AUTHORITY_DENIED'
      await expect(t.authority.authorizePublication(t.accepted, t.sql))
        .rejects.toMatchObject({ code })
    })

  it('accepts the actual authenticated W07 frame while preserving original connection identity', async () => {
    const t = fixture(), frame = { ...t.state.receipt.connection, connectionEpoch: randomUUID() }
    expect(await t.authority.authorizeNativeOutputDeclarations(t.declarationsRequest, frame, t.sql)).toMatchObject({ agentConfigurationVersionId: 'configuration' })
    await t.authority.assertNativeOutputConnection({ ...t.declarationsRequest, operation: 'worker-mcp.authorize-native-output',
      outputOperation: 'create', nativeSessionId: 'original-session', turnId: 'original-turn' }, frame, t.sql)
  })
  it('checks saved declaration permissions before a native turn exists without inventing scope or qualification', async () => {
    const t = fixture(); delete t.state.execution.nativeSessionId; t.state.execution.state = 'starting'; t.state.conversationAvailable = false
    expect(await t.authority.authorizeNativeOutputDeclarations(t.declarationsRequest, t.state.receipt.connection, t.sql)).toEqual({
      agentConfigurationVersionId: 'configuration', outputOperations: ['create', 'append', 'seal', 'publish'],
    })
    expect(t.state.nativeReads).toBe(0)
    expect(t.state.audits).toHaveLength(1)
    expect(t.state.audits[0]![0]).toBe('run-owner')
    expect(JSON.parse(t.state.audits[0]![2] as string)).toEqual({ operationId: t.intent.operationId, attemptId: t.intent.attemptId,
      bindingHash: t.intent.bindingHash, agentConfigurationVersionId: 'configuration', outputOperations: ['create', 'append', 'seal', 'publish'] })
  })
  it.each(['readonly', 'read-grant', 'revoked', 'stopped', 'ended', 'cleanup', 'grant', 'configuration', 'origin-boot', 'origin-generation', 'foreign-intent', 'foreign-placement'] as const)(
    'denies declaration authority for %s without auditing success', async reason => {
      const t = fixture(), request = structuredClone(t.declarationsRequest), connection = structuredClone(t.state.receipt.connection)
      if (reason === 'readonly') t.state.configuration.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'read-only' }
      if (reason === 'read-grant') t.state.writeAllowed = false
      if (reason === 'revoked') t.state.revoked = true
      if (reason === 'stopped') t.state.stopped = true
      if (reason === 'ended') t.state.execution.state = 'completed'
      if (reason === 'cleanup') t.state.cleanup = true
      if (reason === 'grant') t.state.grantLive = false
      if (reason === 'configuration') t.state.configuration.id = 'foreign'
      if (reason === 'origin-boot') connection.bootId = randomUUID()
      if (reason === 'origin-generation') connection.connectionGeneration++
      if (reason === 'foreign-intent') request.intent.inputDigest = 'sha256:' + 'b'.repeat(64)
      if (reason === 'foreign-placement') request.placement.destination.canonicalCwd = '/foreign'
      await expect(t.authority.authorizeNativeOutputDeclarations(request, connection, t.sql)).rejects.toThrow()
      expect(t.state.audits).toEqual([])
    })
  it('requires the original durable native ACK and connection for mutation, even after declaration authorization', async () => {
    const t = fixture(), request = { ...t.declarationsRequest, operation: 'worker-mcp.authorize-native-output' as const,
      outputOperation: 'create' as const, nativeSessionId: 'original-session', turnId: 'original-turn' }
    await t.authority.assertNativeOutputConnection(request, t.state.receipt.connection, t.sql)
    await expect(t.authority.assertNativeOutputConnection({ ...request, turnId: 'foreign' }, t.state.receipt.connection, t.sql)).rejects.toMatchObject({ status: 403 })
    t.state.receipt.stopFence = true
    await expect(t.authority.assertNativeOutputConnection(request, t.state.receipt.connection, t.sql)).rejects.toMatchObject({ status: 403 })
    t.state.receipt.stopFence = false
    await expect(t.authority.assertNativeOutputConnection(request, { ...t.state.receipt.connection, connectionGeneration: 2 }, t.sql)).rejects.toMatchObject({ status: 403 })
  })

  it('resolves only an already admitted original workflow context from saved Run/configuration facts', async () => {
    const t = fixture()
    expect(await t.authority.resolveWorkflowContext(t.attempt, t.accepted.transferContext, t.sql)).toEqual(t.accepted)
    expect((await t.authority.authorize(t.accepted, t.sql)).binding).toBe(bindingIdentity(t.accepted.context))
    expect(t.state.conversationLookup.slice(5)).toEqual([
      'original-session', 'configuration', '/original/worktree', '/original/runtime',
    ])
    expect(t.ports.producer.assertPinsCurrent).toHaveBeenCalledWith(t.sql, t.placement,
      expect.objectContaining({ id: 'run-owner' }), 'workspace', { purpose: 'resident' })
    expect(t.state.conversationWrites).toBe(0)
  })
  it('resolves an authorized context within a bounded nested statement budget', async () => {
    const t = fixture()
    expect(await t.authority.resolveWorkflowContext(t.attempt, t.accepted.transferContext, t.sql)).toEqual(t.accepted)
    expect(t.state.statements).toBeLessThanOrEqual(15)
    expect(t.ports.producer.assertPinsCurrent).toHaveBeenCalledOnce()
    t.state.revoked = true
    await expect(t.authority.resolveWorkflowContext(t.attempt, t.accepted.transferContext, t.sql)).rejects.toMatchObject({ status: 403 })
  })

  it.each([0, 2])('reports missing/ambiguous persisted workflow conversation (%i) without inventing one', async count => {
    const t = fixture(); t.state.conversationCount = count
    await expect(t.authority.resolveWorkflowContext(t.attempt, t.accepted.transferContext, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE' })
  })
  it('derives read-only tools and denies write elevation from saved sandbox or revoked write grants', async () => {
    const t = fixture(); t.state.configuration.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'read-only' }
    const read = await t.authority.resolveWorkflowContext(t.attempt, t.accepted.transferContext, t.sql)
    expect(read.context).toMatchObject({ allowMutation: false, allowedTools: ['files.list', 'files.read'] })
    await expect(t.authority.authorize(t.accepted, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    t.state.configuration.harness = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' }; t.state.writeAllowed = false
    await expect(t.authority.authorize(t.accepted, t.sql)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })
  it.each(['attempt', 'hash', 'execution', 'configuration', 'session', 'turn', 'device', 'installation', 'key', 'conversation', 'revoked', 'grant'] as const)(
    'rejects changed/missing %s without replacement placement or native provider work', async field => {
      const t = fixture(), accepted = structuredClone(t.accepted)
      if (field === 'attempt') accepted.attempt.attemptId = 'replacement'
      if (field === 'hash') accepted.attempt.placementHash = 'b'.repeat(64)
      if (field === 'execution') t.state.execution.agentId = 'replacement'
      if (field === 'configuration') t.state.configuration.id = 'replacement'
      if (field === 'session') t.state.nativeSessionId = 'replacement'
      if (field === 'turn') accepted.context.turnId = 'replacement'
      if (field === 'device') accepted.transferContext.deviceId = randomUUID()
      if (field === 'installation') accepted.transferContext.workerInstallationId = randomUUID()
      if (field === 'key') accepted.transferContext.keyRevision = 2
      if (field === 'conversation') t.state.conversationAvailable = false
      if (field === 'revoked') t.state.revoked = true
      if (field === 'grant') t.state.grantLive = false
      await expect(t.authority.authorize(accepted, t.sql)).rejects.toMatchObject({ status: 403 })
    })
  it('permits stable original registration after reconnect, but not a foreign original sender', async () => {
    const t = fixture(), reconnect = structuredClone(t.accepted)
    reconnect.transferContext.bootId = randomUUID(); reconnect.transferContext.connectionEpoch = randomUUID()
    expect((await t.authority.authorize(reconnect, t.sql)).principal.id).toBe('run-owner')
    reconnect.context.ownerPrincipalId = 'broad-reader'
    await expect(t.authority.authorize(reconnect, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    t.state.callerAllowed = true
    expect((await t.authority.authorize(reconnect, t.sql)).principal.id).toBe('broad-reader')
    expect(t.state.callerChecks.at(-1)).toEqual(['run-owner', 'run', 'broad-reader'])
  })
  it('requires a genuine message receipt when provided and never equates a native message with a turn', async () => {
    const t = fixture(), accepted = structuredClone(t.accepted)
    accepted.context.messageId = 'unadmitted-message'
    await expect(t.authority.authorize(accepted, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    t.state.messages = true
    expect((await t.authority.authorize(accepted, t.sql)).context.messageId).toBe('unadmitted-message')
    accepted.context.nativeMessageId = 'native-message'
    await expect(t.authority.authorize(accepted, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
  })
  it('requires the exact original source, transfer operation and native materialization, and denies a stopped Run', async () => {
    const t = fixture()
    if (!('kind' in t.placement.source)) throw new Error('fixture')
    const transferId = randomUUID()
    const receipt: VerifiedTransferReceipt = { version: 1, receiptId: randomUUID(), transferId, sha256: 'a'.repeat(64), byteSize: 123,
      verifiedAt: new Date().toISOString(), intent: { version: 1, ...t.accepted.transferContext, transferId, operationId: t.intent.operationId,
        executionId: t.attempt.executionId, attemptId: t.attempt.attemptId, placementHash: t.attempt.placementHash,
        rootId: t.placement.source.rootId, rootBindingRevision: 1, direction: 'to-main', byteClass: 'artifact',
        sha256: 'a'.repeat(64), byteSize: 123, manifestDigest: 'b'.repeat(64), chunkBytes: 1024, expiresAt: '2099-01-01T00:00:00.000Z' } }
    await t.authority.assertSourceLive(t.accepted, receipt, t.sql)
    for (const changed of [{ ...receipt, intent: { ...receipt.intent, operationId: randomUUID() } },
      { ...receipt, intent: { ...receipt.intent, rootId: randomUUID() } },
      { ...receipt, intent: { ...receipt.intent, rootBindingRevision: 2 } },
      { ...receipt, sha256: 'c'.repeat(64) }]) {
      await expect(t.authority.assertSourceLive(t.accepted, changed, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    }
    vi.mocked(readNativePlacement).mockResolvedValue(undefined)
    await expect(t.authority.assertSourceLive(t.accepted, receipt, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    vi.mocked(readNativePlacement).mockResolvedValue({ acceptedBindingHash: t.attempt.placementHash } as NativeExecutionPlacement)
    t.state.stopped = true
    await expect(t.authority.assertSourceLive(t.accepted, receipt, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
  })
  it('checks edge grants for accepted consumers without requiring their native launch, including original sender ownership', async () => {
    const t = fixture(), grant = { principalId: 'run-owner', grantId: 'grant', grantRevision: '1' }
    await t.fence.assertCurrent(t.attempt, grant, t.sql)
    expect(t.state.nativeReads).toBe(0)
    await expect(t.fence.assertCurrent(t.attempt, { ...grant, grantRevision: '2' }, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    await expect(t.fence.assertCurrent(t.attempt, { ...grant, principalId: 'reader' }, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
  })
  it('requires the exact persisted output slot, pins, publication, scope and sender for an edge', async () => {
    const t = fixture(), binding = { producer: t.attempt, outputKey: 'report', publication: { ownerPrincipalId: 'run-owner', requestId: 'publication', binding: 'a'.repeat(64) },
      pins: { fileId: randomUUID(), revisionId: randomUUID(), sha256: 'a'.repeat(64), byteSize: 123 }, scope: t.accepted.context.scope,
      sender: { principalId: 'run-owner', grantId: 'grant', grantRevision: '1' } } as ArtifactEdgeBinding
    await expect(t.fence.assertPublishedOutput(binding, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    vi.mocked(readNativeArtifactOutput).mockResolvedValue({ publication: binding.publication, pins: binding.pins, scope: binding.scope } as NonNullable<Awaited<ReturnType<typeof readNativeArtifactOutput>>>)
    await t.fence.assertPublishedOutput(binding, t.sql)
    for (const changed of [{ ...binding, pins: { ...binding.pins, revisionId: randomUUID() } },
      { ...binding, publication: { ...binding.publication, requestId: 'replacement' } },
      { ...binding, sender: { ...binding.sender, principalId: 'reader' } }]) {
      await expect(t.fence.assertPublishedOutput(changed, t.sql)).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_AUTHORITY_DENIED' })
    }
  })
})
