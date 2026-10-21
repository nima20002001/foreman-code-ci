import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
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
  throw new DomainError('WORKER_CONVERSATION_MCP_DENIED', 'The scoped Operator credential does not belong to this worker chat.', 403)
}

/** Reuses normal delegated Operator credentials and the existing Main MCP endpoint. */
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
  }) {}

  private async authorize(request: WorkerConversationMcpRequest, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    signal.throwIfAborted()
    const { binding } = request
    const owner = binding.owner
    const target = binding.profile.target
    if (owner.kind !== 'operator' || target.hostRef.kind !== 'device' || target.hostRef.mainId !== connection.mainId
      || target.hostRef.deviceId !== connection.deviceId || target.applicationInstallationId !== connection.workerInstallationId
      || !isDeepStrictEqual(this.input.current(connection.deviceId), connection)) denied()
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

  async handle(raw: unknown, connection: Readonly<DeviceSessionBinding>, signal: AbortSignal) {
    const request = WorkerConversationMcpRequestSchema.parse(raw)
    const principal = await this.authorize(request, connection, signal)
    if (request.operation === 'conversation-mcp.authorize') {
      return WorkerConversationMcpAuthorizationSchema.parse({ expiresAt: principal.expiresAt })
    }
    const result = await this.input.forward().request(request.body, request.token, request.protocolVersion, signal)
    await this.authorize(request, connection, signal)
    return WorkerMcpRelayResponseSchema.parse(result)
  }
}
