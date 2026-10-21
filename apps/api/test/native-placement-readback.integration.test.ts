import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { SourceRootRecordSchema, SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { bearerToken } from '../src/modules/access/postgres.js'
import { registerOperatorHttpSecurity, requireLocalRequest } from '../src/modules/access/http.js'
import { DomainError } from '../src/modules/errors.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { bindNativeExecution } from '../src/modules/placement/executionBinding.js'
import { insertAcceptedPlacements, insertDispatchIntent, insertNativePlacement } from '../src/modules/placement/persistence.js'
import { RunPlacementReadService } from '../src/modules/placement/readService.js'
import { registerRunPlacementRoutes, registerRunPlacementTool } from '../src/modules/placement/transports.js'
import { createSourceManifest } from '../src/modules/sources/manifest.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../src/modules/sources/bindingHash.js'
import { sourceCwdAttestationDigest } from '../src/modules/sources/workingDirectory.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

it.skipIf(!postgresEnabled)('reads persisted native branch and CWD through authenticated MCP and denies a locationless reader',
  async () => {
    let placement: ReturnType<typeof freezePlacement> | undefined
    const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
      admitPlacementExecutionLocked: async (sql, owner, _run, execution, ref, inputDigest) => {
        if (!placement) throw new Error('Placement fixture is not initialized')
        const intent = deriveDispatch(placement, { executionId: execution.id, attemptId: randomUUID(),
          operationId: randomUUID(), technicalAttempt: execution.attempt,
          occurrenceId: ref.occurrence?.occurrenceId ?? null, occurrenceIndex: ref.occurrence?.occurrenceIndex ?? 0,
          inputDigest, owner: { grantId: randomUUID(), epoch: '1' } })
        await insertDispatchIntent(sql, owner, intent, { assertCurrent: async () => {} })
      } })
    const app = Fastify()
    const clients: Client[] = []
    let owner: RunOwnership | undefined
    try {
      const saveInput = await base.create()
      const saved = (await base.services.workflows.current.save(base.writer.principal, 'http', saveInput)).value
      const draft = await insertCurrentRunFixture(base.db.pool, { ...base.f, run: { ...base.f.run, id: randomUUID() } },
        saved, base.writer.principal.id, { insert: false })
      const node = agentWorkflowNode(draft.version.definition.nodes[0])
      const mainId = (await base.db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
      const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
        capturePolicy: 'git-tree-v1', executablePolicy: 'strip', entries: [], deletions: [],
        git: { repository: 'octo/site', commit: 'a'.repeat(40), tree: 'b'.repeat(40), objectFormat: 'sha1' } })
      const hash = 'c'.repeat(64)
      const rootPolicyId = randomUUID()
      const root = SourceRootRecordSchema.parse({ version: 1,
        source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
          manifestDigest: manifest.manifestDigest },
        selection: { hostRef: { kind: 'main', mainId }, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' },
        binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId: draft.run.workspaceId,
          rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
          canonicalPath: `/native/runtime/source-materializations/${rootPolicyId}`,
          filesystem: { device: '1', inode: '2', mountId: '3' }, accessMode: 'exclusive-write',
          snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
        ownerPrincipalId: base.writer.principal.id, authorizedByPrincipalId: base.writer.principal.id,
        registration: null, attestationId: randomUUID(), attestationDigest: hash, boundAt: base.f.createdAt })
      const requested = { repository: 'octo/site', branch: 'foreman/site/reviewer' }
      placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId,
        runId: draft.run.id, nodeId: node.id, hostRef: root.selection.hostRef, registration: null,
        destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project/src', managedRuntimeRoot: '/native/runtime',
          directoryIdentityHash: hash, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1',
          attestationId: root.attestationId, attestationHash: root.attestationDigest },
        source: { kind: 'pending', ...root.source, revisionId: manifest.snapshotId, rootId: root.binding.rootId,
          bindingRevision: 1, materializationId: null, materializationDigest: null },
        payload: { kind: 'agent', agentId: node.agentId, agentConfigurationVersionId: draft.run.agentConfigurationVersionIds[node.agentId]!,
          driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
          harnessInstallationId: 'installation', installationFingerprint: hash, runtimeContractVersion: 1,
          protocolRevision: '1', credentialScopeRefs: [], worktree: requested } })
      await withExclusiveGraphConnection(base.db.pool, connection => connection.transaction(async sql => {
        await insertRepeatRun(sql, draft.accepted, repeatStartPublication)
        await insertAcceptedPlacements(sql, draft.run.id, [node], draft.run.agentConfigurationVersionIds,
          [placement!], { assertCurrent: async () => {} })
      }))
      owner = await RunOwnership.acquire(base.db.pool, draft.run.id, () => {})
      if (!owner) throw new Error('Expected Run owner')
      const store = await base.runs.repeat(owner)
      const admitted = await store.admit({ nodeId: node.id, occurrence: null }, () => HarnessExecutionSchema.parse({
        id: randomUUID(), runId: draft.run.id, workflowNodeId: node.id, agentId: node.agentId,
        agentConfigurationVersionId: draft.run.agentConfigurationVersionIds[node.agentId],
        attempt: 1, state: 'queued', input: {}, createdAt: base.f.createdAt,
      }))
      if (admitted.kind !== 'admitted') throw new Error('Expected execution admission')
      const dispatch = (await base.db.pool.query<{ record: ReturnType<typeof deriveDispatch> }>(
        'select record from execution_dispatch_intents where execution_id=$1', [admitted.execution.id])).rows[0]!.record
      // Synthetic persisted source/native facts exercise readback; no Git, materialization or provider is executed.
      const materialization = await owner.oneShotConnection().transaction(async sql => {
        await sql.query(`insert into source_approvals
          (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
          values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
        [manifest.approvedSourceId, manifest.snapshotId, draft.run.workspaceId, base.writer.principal.id, randomUUID(), hash])
        await sql.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
          values($1,$2,$3,$4,$5::jsonb)`,
        [manifest.snapshotId, manifest.approvedSourceId, draft.run.workspaceId, manifest.manifestDigest,
          JSON.stringify({ version: 1, workspaceId: draft.run.workspaceId, mainId,
            ownerPrincipalId: base.writer.principal.id, approvedByPrincipalId: base.writer.principal.id,
            locationRevision: 1, originIdentityHash: `sha256:${hash}`, manifest,
            approvedAt: base.f.createdAt, availability: 'retained' })])
        await sql.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
          values($1,$2,$3,1)`, [root.binding.rootId, draft.run.workspaceId, randomUUID()])
        await sql.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
          values($1,1,$2,$3,$4::jsonb)`,
        [root.binding.rootId, draft.run.workspaceId, manifest.snapshotId, JSON.stringify(root)])
        const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture())
        const reservation = await reservations.reserve(sql, { scopeId: randomUUID(), ownerKind: 'materialization',
          ownerId: dispatch.operationId, reservedBytes: 16 * 1024 })
        const worktreeId = randomUUID()
        const receipt = { version: 1 as const, materializationId: randomUUID(), binding: root.binding,
          placementHash: sourceBindingHash(root, { executionId: dispatch.executionId,
            attemptId: dispatch.attemptId, keyRevision: null, authorizationRevision: null }, dispatch.operationId),
          executionId: dispatch.executionId, attemptId: dispatch.attemptId,
          keyRevision: null, authorizationRevision: null, verifiedManifestDigest: manifest.manifestDigest,
          verifiedEntries: 0, verifiedBytes: 0, verifiedAt: base.f.createdAt,
          localTreeIdentity: root.binding.filesystem, claimScope: 'execution' as const,
          sharedTree: { id: worktreeId, referenceIdentity: root.binding.filesystem },
          worktree: { ...requested, branch: `${requested.branch}-${randomUUID()}`, commit: manifest.git!.commit } }
        const record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId, rootPolicyRevision: '1',
          operationId: dispatch.operationId, reservationId: reservation.reservationId,
          sourceBindingHash: receipt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
        const canonicalProjectRoot = `${root.binding.canonicalPath}/${worktreeId}/tree`
        const fields = { version: 1 as const, materializationId: receipt.materializationId,
          executionId: dispatch.executionId, attemptId: dispatch.attemptId, operationId: dispatch.operationId,
          sourceBindingHash: receipt.placementHash, relativeCwd: 'src', canonicalCwd: `${canonicalProjectRoot}/src`,
          filesystem: root.binding.filesystem, directoryIdentityHash: hash, accessMode: root.binding.accessMode }
        const native = bindNativeExecution(placement!, dispatch, record, {
          materializationId: receipt.materializationId, materializationDigest: sourceMaterializationDigest(record),
          canonicalProjectRoot, canonicalCwd: fields.canonicalCwd, directoryIdentityHash: hash,
          filesystem: root.binding.filesystem, accessMode: root.binding.accessMode, privateGit: null,
          cwdAttestation: { ...fields, attestationDigest: sourceCwdAttestationDigest(fields) },
        })
        const adopted = { ...record, finalDispatchBindingHash: native.bindingHash }
        await sql.query(`insert into source_execution_materializations
          (materialization_id,workspace_id,execution_id,attempt_id,operation_id,root_id,binding_revision,reservation_id,record,state)
          values($1,$2,$3,$4,$5,$6,1,$7,$8::jsonb,'prepared')`,
        [receipt.materializationId, draft.run.workspaceId, dispatch.executionId, dispatch.attemptId,
          dispatch.operationId, root.binding.rootId, reservation.reservationId, JSON.stringify(adopted)])
        await reservations.retain(sql, reservation, 'owned')
        await insertNativePlacement(sql, owner!, native)
        return { ...native, materialization: adopted }
      })
      await owner.release()
      owner = undefined
      let reads = new RunPlacementReadService(base.db.pool, async () => [])
      registerOperatorHttpSecurity(app, base.access)
      registerRunPlacementRoutes(app, reads)
      app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
        .send({ error: { code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' } }))
      app.post('/mcp', async (request, reply) => {
        requireLocalRequest(request)
        const principal = await base.access.authenticate(bearerToken(request.headers.authorization), 'operator')
        const server = new McpServer({ name: 'native-placement-readback', version: '1' })
        registerRunPlacementTool(server, reads, principal, base.commands)
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        reply.raw.once('close', () => { void Promise.allSettled([transport.close(), server.close()]) })
        await server.connect(transport)
        reply.hijack()
        await transport.handleRequest(request.raw, reply.raw, request.body)
      })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(token: string) {
        const client = new Client({ name: 'native-placement-reader', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => token } }))
        return client
      }
      const input = { workspaceId: draft.run.workspaceId, workflowId: draft.run.workflowId,
        runId: draft.run.id, nodeId: node.id }
      const reader = await connect(base.writer.token)
      const read = async () => RunPlacementGetResultSchema.parse(decodeMcpToolResult(
        await reader.callTool({ name: 'run_node_placement_get', arguments: input })))
      expect((await read()).readback).toMatchObject({ evidence: 'accepted',
        placement: { payload: { worktree: requested } }, nativePlacements: [materialization] })
      reads = new RunPlacementReadService(base.db.pool, async () => [])
      expect((await read()).readback).toMatchObject({ nativePlacements: [materialization] })
      const denied = await base.access.issue({ name: 'Run reader without locations', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['runs:read'], scope: { runIds: [draft.run.id] } }] })
      const deniedReader = await connect(denied.token)
      const deniedResult = await deniedReader.callTool({ name: 'run_node_placement_get', arguments: input })
      expect(deniedResult.isError).toBe(true)
      expect(JSON.stringify(deniedResult.content)).not.toContain(materialization.workingTree.canonicalCwd)
      const response = await app.inject({ method: 'GET', headers: { authorization: `Bearer ${denied.token}` },
        url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs/${input.runId}/nodes/${input.nodeId}/placement` })
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('ACCESS_DENIED')
      expect(response.body).not.toContain(materialization.materialization.receipt.worktree!.branch)
    } finally {
      await owner?.release()
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
      await base.close()
    }
  }, 120_000)
