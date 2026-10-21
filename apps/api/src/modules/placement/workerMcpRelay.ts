import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { WorkerMcpRelayRequestSchema, WorkerMcpRelayAuthorizationSchema, WorkerMcpRelayResponseSchema, WorkerNativeOutputAuthorizationSchema,
  WorkerNativeOutputDeclarationsAuthorizationSchema, WorkerNativeOutputDeclarationsPolicySchema,
  WorkerNativeOutputReadinessSchema,
  type WorkerNativeOutputDeclarationsPolicy, type WorkerMcpRelayRequest } from '@foreman-code/contracts/worker-mcp-relay'
import { TemporaryFileScopeSchema, type TemporaryFileScope } from '@foreman-code/contracts/files'
import { WORKER_NATIVE_OUTPUT_FILE_OPERATIONS } from '@foreman-code/contracts/worker-native-output'
import type { PostgresArtifactPublicationAuthority } from '../runs/remote/nativeArtifactAuthority.js'
import type { AcceptedArtifactPublication } from '../files/distributed/publication.js'
import type { FileQuery } from '../files/repository.js'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { PostgresAccessService } from '../access/postgres.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { requireAuthorization } from '../access/policy.js'
import { workerScopesForAction } from '../access/appPolicy.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { readAcceptedPlacement } from './persistence.js'
import { DomainError, databaseReadFailure } from '../errors.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { requestAppMcp } from '../harnesses/appMcpHttp.js'

export interface SelectedMainMcpForward {
  /** Existing selected main's MCP transports, with this exact worker bearer;
   * never browser cookies, Operator secrets or another worker's loopback app. */
  request(body: unknown, token: string, protocolVersion?: string, signal?: AbortSignal): Promise<{
    statusCode: number; contentType: 'application/json' | 'text/event-stream' | 'empty'; body: string
  }>
}
export type NativeOutputRequest = Extract<WorkerMcpRelayRequest, { operation: 'worker-mcp.authorize-native-output' }>
export type NativeOutputDeclarationsRequest = Extract<WorkerMcpRelayRequest, { operation: 'worker-mcp.authorize-native-output-declarations' }>
export interface WorkerNativeOutputAuthorizationPort {
  /** Must use the actual original admitted publication context, never tool scope or a replacement lease. */
  authorize(input: NativeOutputRequest, connection: DeviceConnectionIdentity, sql: FileQuery): Promise<TemporaryFileScope>
  authorizeDeclarations(input: NativeOutputDeclarationsRequest, connection: DeviceConnectionIdentity, sql: FileQuery): Promise<WorkerNativeOutputDeclarationsPolicy>
}
export function createWorkerNativeOutputAuthorizationPort(
  authority: Pick<PostgresArtifactPublicationAuthority, 'authorize' | 'assertNativeOutputConnection' | 'authorizeNativeOutputDeclarations'>,
  resolveAccepted: (input: NativeOutputRequest, connection: DeviceConnectionIdentity, sql: FileQuery) => Promise<AcceptedArtifactPublication>,
): WorkerNativeOutputAuthorizationPort {
  return { async authorize(input, connection, sql) {
    await authority.assertNativeOutputConnection(input, connection, sql)
    const accepted = await resolveAccepted(input, connection, sql)
    const caller = await authority.authorize(accepted, sql)
    const scope = caller.context.scope.chat
    if (scope.kind !== 'agent' || scope.runId !== input.intent.runId || scope.executionId !== input.intent.executionId
      || scope.agentId !== input.applicationAccess.agentId || accepted.attempt.executionId !== input.intent.executionId
      || accepted.attempt.runId !== input.intent.runId || accepted.attempt.nodeId !== input.intent.nodeId
      || scope.workspaceId !== accepted.attempt.workspaceId || scope.workflowId !== accepted.attempt.workflowId
      || accepted.attempt.attemptId !== input.intent.attemptId || accepted.attempt.placementHash !== input.intent.bindingHash
      || caller.context.nativeSessionId !== input.nativeSessionId || caller.context.turnId !== input.turnId
      || !caller.context.allowMutation || !caller.context.allowedTools.includes(WORKER_NATIVE_OUTPUT_FILE_OPERATIONS[input.outputOperation])) {
      throw new DomainError('WORKER_NATIVE_OUTPUT_DENIED', 'The original native file operation is not authorized.', 403)
    }
    requireAuthorization(caller.principal, 'agent_chat:write', {
      workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
    })
    await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'device',$2,$3,'succeeded',$4::jsonb)`, [caller.principal.id, `native_output.authorize.${input.outputOperation}`,
      `execution:${input.intent.executionId}`, JSON.stringify({ operationId: input.intent.operationId, attemptId: input.intent.attemptId,
        bindingHash: input.intent.bindingHash, nativeSessionId: input.nativeSessionId, turnId: input.turnId, scope: caller.context.scope })])
    return TemporaryFileScopeSchema.parse(structuredClone(caller.context.scope))
  }, async authorizeDeclarations(input, connection, sql) {
    return WorkerNativeOutputDeclarationsPolicySchema.parse(await authority.authorizeNativeOutputDeclarations(input, connection, sql))
  } }
}
/** Main-only domain handler on the authenticated worker MCP namespace. It
 * validates the original execution lease before the existing MCP transport
 * repeats normal role/tool/scope authorization. No new credential is minted. */
export class MainWorkerMcpRelay {
  constructor(private readonly mainId: string, private readonly pool: pg.Pool,
    private readonly access: Pick<PostgresAccessService, 'authenticate'>, private readonly forward: SelectedMainMcpForward,
    private readonly nativeOutputs?: WorkerNativeOutputAuthorizationPort) {}
  async handle(raw: unknown, connection: DeviceConnectionIdentity, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const input = WorkerMcpRelayRequestSchema.parse(raw), app = input.applicationAccess
    { const d = ((globalThis as { __diag?: Record<string, number> }).__diag ??= {}); const k = `relay:${input.operation}`; d[k] = (d[k] ?? 0) + 1 }
    const principal = await this.access.authenticate(app.token, 'worker').catch((error: unknown) => { throw databaseReadFailure(error) })
    if (principal.audience !== 'worker' || principal.agentId !== app.agentId || input.placement.payload.kind !== 'agent'
      || input.placement.payload.agentId !== app.agentId || input.intent.executionId !== app.executionId
      || input.intent.operationId !== app.operationId || input.intent.attemptId !== app.attemptId
      || input.intent.bindingHash !== app.bindingHash || input.placement.bindingHash !== app.bindingHash
      || input.intent.mainId !== this.mainId || connection.mainId !== this.mainId) {
      throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'Application access must match the original execution lease.', 403)
    }
    // Admission reads the latest committed lease without row locks: nothing it reads is changed here and
    // the Worker acts only after COMMIT, so waiting behind a busy Run would only fail the device request.
    const { authorization, nativeScope, declarations, ready } = await withTransaction(this.pool, async (client) => {
      let nativeScope: TemporaryFileScope | undefined
      let declarations: WorkerNativeOutputDeclarationsPolicy | undefined
      let ready = false
      const intent = await readReconciledDispatchIntent(client, app.operationId)
      const placement = await readAcceptedPlacement(client, input.intent.runId, input.intent.nodeId)
      if (!intent || !placement || !sameWorkflowValue(intent, input.intent) || !sameWorkflowValue(placement, input.placement)
        || placement.hostRef.kind !== 'device' || placement.hostRef.deviceId !== connection.deviceId) {
        throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'The MCP caller is outside the accepted dispatch.', 403)
      }
      const registration = await assertDeviceHostInstallation(client, placement.hostRef, connection.workerInstallationId)
      if (!registration || !placement.registration || registration.keyRevision !== connection.keyRevision
        || registration.authorizationRevision !== connection.authorizationRevision
        || registration.keyRevision !== placement.registration.keyRevision || registration.authorizationRevision !== placement.registration.authorizationRevision) {
        throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'The execution device grant changed.', 403)
      }
      const rows = await client.query<{ execution_id: string; run_id: string; workspace_id: string; workflow_id: string; agent_id: string; purpose: string; revoked_at: Date | null;
        execution_state: string; run_state: string; authorization_principal_id: string; stopped: boolean; cleanup: boolean }>(`select b.execution_id,b.run_id,b.workspace_id,b.workflow_id,b.agent_id,b.purpose,b.revoked_at,
        he.record->>'state' as execution_state,r.execution_state as run_state,r.record->>'authorizationPrincipalId' as authorization_principal_id,
        r.stop_requested_at is not null as stopped,
        exists(select 1 from run_cleanup_intents i where i.run_id=r.id and i.pending) as cleanup
        from worker_credential_bindings b join harness_executions he on he.id=b.execution_id join runs r on r.id=b.run_id
        where b.principal_id=$1 and b.execution_id=$2`, [principal.id, app.executionId])
      const binding = rows.rows[0]
      if (rows.rows.length !== 1 || !binding || binding.revoked_at || binding.execution_id !== app.executionId || binding.run_id !== intent.runId
        || binding.agent_id !== app.agentId || binding.stopped || binding.cleanup || !['running', 'waiting'].includes(binding.run_state)
        || (binding.purpose === 'workflow' ? !['starting', 'running', 'waiting'].includes(binding.execution_state)
          : binding.purpose !== 'reviewer' || binding.execution_state !== 'completed')) {
        throw new DomainError('WORKER_MCP_LEASE_UNAVAILABLE', 'The original application lease no longer permits native tool access.', 403)
      }
      if (!workerScopesForAction(principal, 'interactions:read').some(scope => scope.workspaceIds?.includes(binding.workspace_id)
        && scope.workflowIds?.includes(binding.workflow_id) && scope.runIds?.includes(binding.run_id))) {
        throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'The worker grant must cover the complete original execution scope.', 403)
      }
      const authority = await currentOperatorAuthority(client, binding.authorization_principal_id)
      requireAuthorization(authority.principal, 'runs:start', { workspaceId: binding.workspace_id, workflowId: binding.workflow_id })
      const authorization = WorkerMcpRelayAuthorizationSchema.parse({ version: 1, mainId: this.mainId, audience: 'worker', principalId: principal.id,
        executionId: app.executionId, agentId: app.agentId, operationId: app.operationId, attemptId: app.attemptId, bindingHash: app.bindingHash, expiresAt: principal.expiresAt })
      if (input.operation === 'worker-mcp.authorize-native-output'
        || input.operation === 'worker-mcp.authorize-native-output-declarations'
        || input.operation === 'worker-mcp.native-output-readiness') {
        if (binding.purpose !== 'workflow' || placement.payload.kind !== 'agent' || !placement.payload.artifactOutputs) {
          throw new DomainError('WORKER_NATIVE_OUTPUT_DENIED', 'Native output requires the original declared workflow Agent.', 403)
        }
        if (!this.nativeOutputs) throw new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE', 'Native output authorization is not mounted.', 409)
        if (input.operation === 'worker-mcp.authorize-native-output') {
          nativeScope = TemporaryFileScopeSchema.parse(await this.nativeOutputs.authorize(input, connection, client))
          if (nativeScope.chat.kind !== 'agent' || nativeScope.chat.workspaceId !== binding.workspace_id
            || nativeScope.chat.workflowId !== binding.workflow_id || nativeScope.chat.runId !== intent.runId) {
            throw new DomainError('WORKER_NATIVE_OUTPUT_DENIED', 'The original native output file scope changed.', 403)
          }
          // Validate the returned scope while rollback can still reject a bad provider response.
          WorkerNativeOutputAuthorizationSchema.parse({ ...authorization, outputOperation: input.outputOperation,
            nativeSessionId: input.nativeSessionId, turnId: input.turnId, scope: nativeScope })
        } else {
          const declarationInput = { version: input.version, intent: input.intent, placement: input.placement,
            applicationAccess: input.applicationAccess, operation: 'worker-mcp.authorize-native-output-declarations' as const }
          declarations = WorkerNativeOutputDeclarationsPolicySchema.parse(
            await this.nativeOutputs.authorizeDeclarations(declarationInput, connection, client))
          if (declarations.agentConfigurationVersionId !== placement.payload.agentConfigurationVersionId) {
            throw new DomainError('WORKER_NATIVE_OUTPUT_DENIED', 'The accepted native output configuration changed.', 403)
          }
          if (input.operation === 'worker-mcp.native-output-readiness') {
            const row = (await client.query<{ receipt: unknown }>(
              'select receipt from remote_execution_receipts where operation_id=$1', [intent.operationId])).rows[0]
            const receipt = row && RemoteOperationReceiptSchema.parse(row.receipt)
            if (receipt?.native && (receipt.native.sessionId !== input.nativeSessionId
              || receipt.native.turnId && receipt.native.turnId !== input.turnId)) {
              throw new DomainError('WORKER_MCP_SCOPE_CONFLICT', 'Native output readiness belongs to another turn.', 403)
            }
            ready = receipt?.native?.sessionId === input.nativeSessionId && receipt.native.turnId === input.turnId
              && (await client.query(`select 1 from operator_conversations where kind='agent' and deleted_at is null
                and origin_run_id=$1 and origin_execution_id=$2 and native_session_id=$3
                and record#>>'{workflowFileContext,context,turnId}'=$4`,
              [intent.runId, intent.executionId, input.nativeSessionId, input.turnId])).rowCount === 1
          }
        }
      }
      signal?.throwIfAborted()
      return { authorization, nativeScope, declarations, ready }
    }).catch((error: unknown) => { throw databaseReadFailure(error) })
    if (input.operation === 'worker-mcp.authorize') return authorization
    if (input.operation === 'worker-mcp.authorize-native-output') return WorkerNativeOutputAuthorizationSchema.parse({
      ...authorization, outputOperation: input.outputOperation, nativeSessionId: input.nativeSessionId, turnId: input.turnId, scope: nativeScope,
    })
    if (input.operation === 'worker-mcp.authorize-native-output-declarations') return WorkerNativeOutputDeclarationsAuthorizationSchema.parse({ ...authorization, ...declarations })
    if (input.operation === 'worker-mcp.native-output-readiness') { const d = ((globalThis as { __diag?: Record<string, number> }).__diag ??= {}); const k = `ready:${ready}`; d[k] = (d[k] ?? 0) + 1 }
    if (input.operation === 'worker-mcp.native-output-readiness') return WorkerNativeOutputReadinessSchema.parse({
      ...authorization, nativeSessionId: input.nativeSessionId, turnId: input.turnId, ready,
    })
    signal?.throwIfAborted()
    return WorkerMcpRelayResponseSchema.parse(await this.forward.request(
      input.body, app.token, input.protocolVersion, signal,
    ))
  }
}

const artifactToolPaths = new Map([
  ['files.admit_transferred_result', '/mcp/artifact-transfers'],
  ['files.publish_transferred_result', '/mcp/artifact-publications'],
  ['files.read_edge_input', '/mcp/artifact-inputs'],
])

/** Uses the existing selected main app instance and authentication path. It
 * exposes no new listener and never forwards cookies or an Operator bearer. */
export function selectedMainMcpForward(app: import('fastify').FastifyInstance): SelectedMainMcpForward {
  return { async request(body, token, protocolVersion, signal) {
    signal?.throwIfAborted()
    const request = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined
    const params = request?.params && typeof request.params === 'object' && !Array.isArray(request.params)
      ? request.params as Record<string, unknown> : undefined
    const url = request?.method === 'tools/call' && typeof params?.name === 'string'
      ? artifactToolPaths.get(params.name) ?? '/mcp' : '/mcp'
    const address = app.server.address()
    if (!app.server.listening || !address || typeof address === 'string') {
      throw new DomainError('WORKER_MCP_UNAVAILABLE', 'The selected Main HTTP listener is unavailable.', 503)
    }
    let host = address.address
    if (host === '0.0.0.0') host = '127.0.0.1'
    else if (host === '::') host = '::1'
    const authority = `${host.includes(':') ? `[${host}]` : host}:${address.port}`
    return requestAppMcp(`http://${authority}${url}`, body, token, protocolVersion, signal)
  } }
}
