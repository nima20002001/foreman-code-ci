import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { OperatorConfigurationVersionSchema, type AgentSubject } from '@foreman-code/contracts'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { WorkerConversationMcpRequestSchema, WorkerConversationMcpAuthorizationSchema,
  WorkerMcpRelayResponseSchema, type WorkerConversationMcpRequest } from '@foreman-code/contracts/worker-mcp-relay'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { PostgresAccessService } from '../access/postgres.js'
import type { AcceptedHarnessProfileAdmission } from '../harnesses/instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from '../harnesses/claudeSdk/production.js'
import type { SelectedMainMcpForward } from '../placement/workerMcpRelay.js'
import type { MainWorkerConversationBridge } from './workerBridge.js'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { DomainError } from '../errors.js'
import { sameConversationForAppAccess } from './conversationAppAccess.js'
import { workerExecutionConfiguration } from './workerExecutionConfiguration.js'

function denied(): never {
  throw new DomainError('WORKER_CONVERSATION_MCP_DENIED', 'The scoped credential does not belong to this worker conversation.', 403)
}

/** D supplies the existing scoped credential resolver and feature tools, never an Operator credential. */
export interface WorkerConversationAgentMcp {
  authorize(request: WorkerConversationMcpRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal): Promise<{
    subject: Extract<AgentSubject, { kind: 'conversation' }>; expiresAt: string
  }>
  forward(): SelectedMainMcpForward
}

/** Both subjects use their normal credentials; C retains exact paired-Worker and conversation fences. */
export class MainWorkerConversationMcp {
  constructor(private readonly input: {
    pool: pg.Pool
    access: Pick<PostgresAccessService, 'authenticate'>
    operators: PostgresOperatorConversationRepository
    profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
    claudeProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
    bridge: MainWorkerConversationBridge
    current(deviceId: string): Readonly<DeviceSessionBinding> | undefined
    forward(): SelectedMainMcpForward
    agent?: WorkerConversationAgentMcp
  }) {}

  private async authorize(request: WorkerConversationMcpRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    signal.throwIfAborted()
    const { binding } = request
    const owner = binding.owner
    const target = binding.profile.target
    if (binding.appMcpAccess !== 'scoped' || target.hostRef.kind !== 'device' || target.hostRef.mainId !== connection.mainId
      || target.hostRef.deviceId !== connection.deviceId || target.applicationInstallationId !== connection.workerInstallationId
      || !isDeepStrictEqual(this.input.current(connection.deviceId), connection)) denied()
    if (owner.kind === 'agent') return this.authorizeAgent(request, connection, signal)
    const principal = await this.input.access.authenticate(request.token, 'operator')
    const stored = (await this.input.pool.query<{ owner_principal_id: string; worker_conversation_binding: unknown;
      record: unknown; principal_id: string; delegated_from: string }>(`select c.owner_principal_id,c.worker_conversation_binding,
        cfg.record,p.id as principal_id,p.delegated_from
      from operator_chat_credentials credential join management_principals p on p.id=credential.principal_id
      join operator_conversations c on c.id=credential.conversation_id
      join operator_configuration_versions cfg on cfg.id=c.operator_configuration_version_id
      where p.id=$1 and c.id=$2 and c.kind='operator' and c.deleted_at is null and c.record->>'status'='open'`,
    [principal.id, owner.conversationId])).rows[0]
    if (!stored || stored.delegated_from !== stored.owner_principal_id) denied()
    const configuration = OperatorConfigurationVersionSchema.parse(stored.record)
    const previous = configuration.id === owner.configurationVersionId ? undefined
      : await this.input.operators.configuration(owner.configurationVersionId)
    let executionConfiguration
    try {
      executionConfiguration = workerExecutionConfiguration(binding, configuration, previous ?? undefined)
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WORKER_CONVERSATION_UNAVAILABLE') denied()
      throw error
    }
    if (!('operatorId' in executionConfiguration) || executionConfiguration.operatorId !== owner.operatorId
      || executionConfiguration.harness.harness !== binding.harness
      || commandInputHash(executionConfiguration) !== owner.configurationHash
      || !isDeepStrictEqual(executionConfiguration.harnessProfileSelection, binding.profile)) denied()
    if (stored.worker_conversation_binding) {
      const previous = WorkerConversationBindingSchema.parse(stored.worker_conversation_binding)
      if (!isDeepStrictEqual(previous, binding)) {
        if (!request.admissionId || !sameConversationForAppAccess(previous, binding)) denied()
        await this.input.bridge.authorizeAppAccessChange(request.admissionId, previous, binding, connection, signal)
      }
    } else {
      if (!request.admissionId) denied()
      await this.input.bridge.handle({ method: 'conversation.profile', admissionId: request.admissionId, binding }, connection, signal)
    }
    const profiles = binding.harness === 'claude' ? this.input.claudeProfiles : this.input.profiles
    await profiles.admit({ kind: 'operator', conversationId: owner.conversationId,
      repository: this.input.operators, controlPrincipalId: stored.owner_principal_id, admissionSignal: signal }, binding.profile)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(this.input.current(connection.deviceId), connection)) denied()
    return principal
  }

  private async authorizeAgent(request: WorkerConversationMcpRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const { binding } = request, owner = binding.owner
    if (owner.kind !== 'agent' || !this.input.agent) denied()
    const stored = (await this.input.pool.query<{ workspace_id: string; workflow_id: string; workflow_node_id: string;
      agent_id: string; worker_conversation_binding: unknown }>(`select workspace_id,workflow_id,workflow_node_id,
        agent_id,worker_conversation_binding from operator_conversations where id=$1 and kind='agent'
        and deleted_at is null and not coalesce((record->>'archived')::boolean,false)`, [owner.conversationId])).rows[0]
    if (!stored || stored.workspace_id !== owner.workspaceId || stored.workflow_id !== owner.workflowId
      || stored.workflow_node_id !== owner.workflowNodeId || stored.agent_id !== owner.agentId) denied()
    if (!stored.worker_conversation_binding || !isDeepStrictEqual(WorkerConversationBindingSchema.parse(stored.worker_conversation_binding), binding)) {
      if (!request.admissionId) denied()
      // Main's original accepted input/profile authorization is also required before its first native binding exists.
      await this.input.bridge.handle({ method: 'conversation.profile', admissionId: request.admissionId, binding }, connection, signal)
    }
    const authorized = await this.input.agent.authorize(request, connection, signal)
    const subject = authorized.subject
    if (subject.kind !== 'conversation' || subject.conversationId !== owner.conversationId
      || subject.agent.workspaceId !== owner.workspaceId || subject.agent.workflowId !== owner.workflowId
      || subject.agent.workflowNodeId !== owner.workflowNodeId || subject.agent.agentId !== owner.agentId
      || subject.agent.configurationVersionId !== owner.configurationVersionId) denied()
    signal.throwIfAborted()
    if (!isDeepStrictEqual(this.input.current(connection.deviceId), connection)) denied()
    return authorized
  }

  async handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const request = WorkerConversationMcpRequestSchema.parse(raw)
    const principal = await this.authorize(request, connection, signal)
    if (request.operation === 'conversation-mcp.authorize') {
      return WorkerConversationMcpAuthorizationSchema.parse({ expiresAt: principal.expiresAt })
    }
    const forward = request.binding.owner.kind === 'agent' ? this.input.agent?.forward() : this.input.forward()
    if (!forward) denied()
    const result = await forward.request(request.body, request.token, request.protocolVersion, signal)
    await this.authorize(request, connection, signal)
    return WorkerMcpRelayResponseSchema.parse(result)
  }
}
