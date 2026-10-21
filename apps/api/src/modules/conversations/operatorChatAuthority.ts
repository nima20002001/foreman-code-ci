import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../infrastructure/transaction.js'
import { APP_MCP_SERVER_NAME, APP_MCP_TIMEOUTS, appLauncherPath, isSupportedAppMcpServerName, isSupportedAppMcpTokenName,
  registerAppRoute } from '../harnesses/appMcpLauncher.js'
import { requestAppMcp } from '../harnesses/appMcpHttp.js'
import { createUnboundWorkerMcpEndpoint } from '../runs/remote/workerMcpEndpoint.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../access/workerCredentials.js'
import type pg from 'pg'
import type { OperatorChatSetup, OperatorConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { operatorChatGrants } from '../access/operatorChatDelegation.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { NativeMcpInspector } from '../harnesses/mcpDetection.js'
import type { NativeRollout } from '../harnesses/nativeRollout.js'
import type { ChildProcessEnvironment, NativeHarnessSessionManager } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { OperatorChatAuthority } from './operatorChat.js'
import { sameOperatorExecutionConfiguration } from './workerExecutionConfiguration.js'

export const OPERATOR_MCP_ENVIRONMENT_VARIABLE = APP_MCP_TOKEN_ENVIRONMENT_VARIABLE

interface ConversationCredential {
  environment: ChildProcessEnvironment
  ownerId: string
  configuration: OperatorConfigurationVersion
  manager: NativeHarnessSessionManager
  channel?: string
  relay?: Awaited<ReturnType<typeof createUnboundWorkerMcpEndpoint>>
  removeRoute?: () => Promise<void>
  principalId?: string
}

export class PostgresOperatorChatAuthority implements OperatorChatAuthority {
  private readonly credentials = new Map<string, ConversationCredential>()
  private readonly managedLaunchers = new WeakSet<NativeHarnessSessionManager>()
  constructor(private readonly pool: pg.Pool, private readonly access: PostgresAccessService,
    private readonly rollout: NativeRollout, private readonly directory: string, private readonly endpoint: string,
    private readonly inspectorFor?: (manager: NativeHarnessSessionManager) => NativeMcpInspector,
    private readonly deliverClaudeCredential?: (manager: NativeHarnessSessionManager, configuration: OperatorConfigurationVersion,
      environment: ChildProcessEnvironment, signal: AbortSignal) => Promise<void>,
    private readonly inspectClaudeConfiguration?: (principal: ManagementPrincipal, configuration: OperatorConfigurationVersion,
      signal: AbortSignal) => Promise<OperatorChatSetup>) {}

  current(principalId: string) { return this.access.currentOperator(principalId) }
  assertConfiguration(configuration: OperatorConfigurationVersion) {
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    if (configuration.harness.harness === 'claude') {
      if (!configuration.harnessProfileSelection || !this.deliverClaudeCredential) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
        'Claude Operator chat requires an explicit host profile and composed native admission.', 409)
      return
    }
    this.rollout.assertChat(configuration)
  }

  async setupConfiguration(principal: ManagementPrincipal, configuration: OperatorConfigurationVersion, signal: AbortSignal): Promise<OperatorChatSetup> {
    const current = await this.access.currentHarnessInspectionPrincipal(principal.id)
    requireAuthorization(current, 'harnesses:read')
    signal.throwIfAborted()
    this.assertConfiguration(configuration)
    if (configuration.harness.harness !== 'claude' || !this.inspectClaudeConfiguration) throw new DomainError(
      'OPERATOR_SETUP_INSPECTION_UNAVAILABLE', 'Claude installation inspection is unavailable.', 503)
    const result = await this.inspectClaudeConfiguration(current, configuration, signal)
    signal.throwIfAborted()
    requireAuthorization(await this.access.currentHarnessInspectionPrincipal(principal.id), 'harnesses:read')
    if (result.harness !== 'claude' || result.endpoint !== this.endpoint
      || result.configurationVersionId && result.configurationVersionId !== configuration.id) throw new DomainError(
      'MCP_INSPECTION_CONTEXT_MISMATCH', 'Native MCP inspection returned another Operator launch context.', 500)
    return result
  }

  async setup(manager: NativeHarnessSessionManager, signal: AbortSignal): Promise<OperatorChatSetup> {
    const result = { harness: manager.harness, endpoint: this.endpoint, checkedAt: new Date().toISOString() }
    if (!this.inspectorFor) this.invalidSetup()
    const context = manager.mcpInspectionContext ? await manager.mcpInspectionContext(signal)
      : { runnerId: 'runner-local', workingDirectory: this.directory }
    const inspected = await this.inspectorFor(manager).inspect({ harness: manager.harness, ...context,
      serverName: APP_MCP_SERVER_NAME, phase: 'configuration', signal })
    signal.throwIfAborted()
    if (inspected.harness !== manager.harness || inspected.runnerId !== context.runnerId
      || inspected.workingDirectory !== context.workingDirectory) throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH',
      'Native MCP inspection returned another Operator launch context.', 500)
    const entry = inspected.entry
    if (!entry) return { ...result, status: 'setup_required' }
    const automatic = entry.automaticEndpoint === true && entry.transport === 'stdio'
    const paired = manager.harness === 'claude' && entry.pairedEndpoint !== undefined
      && `device:${entry.pairedEndpoint.deviceId}` === context.runnerId
      && entry.pairedEndpoint.configuredEndpoint === this.endpoint
      && entry.pairedEndpoint.nativeEndpoint === entry.endpoint && entry.transport === 'streamable-http'
    const configured = isSupportedAppMcpServerName(entry.name) && entry.enabled !== false && entry.status !== 'disabled'
      && (automatic || paired || entry.endpoint === this.endpoint && entry.transport === 'streamable-http')
      && (manager.harness === 'claude' ? Boolean(this.deliverClaudeCredential)
        : isSupportedAppMcpTokenName(entry.credentialEnvironmentVariable))
    if (configured && automatic && manager.harness === 'codex' && manager.retireTurn && context.runnerId === 'runner-local') {
      this.managedLaunchers.add(manager)
    }
    return { ...result, status: configured ? 'configured' : 'setup_required', routing: automatic || paired ? 'automatic' : 'fixed' }
  }

  async prepare(manager: NativeHarnessSessionManager, configuration: OperatorConfigurationVersion, conversationId: string,
    principalId: string, signal: AbortSignal): Promise<ChildProcessEnvironment> {
    const principal = await this.current(principalId)
    requireAuthorization(principal, 'operator_chat:write')
    signal.throwIfAborted()
    const cached = this.credentials.get(conversationId)
    if (cached) {
      if (cached.ownerId !== principalId || cached.manager !== manager
        || !sameOperatorExecutionConfiguration(cached.configuration, configuration)) {
        throw new DomainError('ACCESS_DENIED', 'A native credential cannot change its accepted owner or configuration.', 403)
      }
      if (cached.principalId) return cached.environment
    }
    if (!cached && (await this.setup(manager, signal)).status !== 'configured') this.invalidSetup()
    this.assertConfiguration(configuration)
    signal.throwIfAborted()
    const issued = await withTransaction(this.pool, async (client) => {
      // Same ordering as Run review shutdown: parent authority, then conversation.
      await client.query('select id from management_principals where id=$1 for share', [principalId])
      const owner = (await currentOperatorAuthority(client, principalId)).principal
      requireAuthorization(owner, 'operator_chat:write')
      const conversation = await client.query(`select id from operator_conversations
        where id=$1 and owner_principal_id=$2 and record->>'status'='open' for share`, [conversationId, principalId])
      if (conversation.rowCount !== 1) throw new DomainError('OPERATOR_REVIEW_ENDED', 'The conversation is no longer open.', 409)
      signal.throwIfAborted()
      const grants = operatorChatGrants(owner.grants)
      if (!grants.length) throw new DomainError('ACCESS_DENIED', 'This principal has no management authority to delegate to the Operator.', 403)
      const issued = await this.access.issue({ name: `operator-chat:${conversationId}`, audience: 'operator', grants }, client)
      // Issuance and both bindings commit together. End/release cannot miss a late credential.
      await client.query('update management_principals set delegated_from=$2 where id=$1', [issued.principal.id, owner.id])
      await client.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)', [issued.principal.id, conversationId])
      signal.throwIfAborted()
      return issued
    })
    let removeRoute: (() => Promise<void>) | undefined
    let relay = cached?.relay
    try {
      signal.throwIfAborted()
      const channel = cached?.channel ?? (this.managedLaunchers.has(manager) ? randomBytes(32).toString('base64url') : undefined)
      const environment = channel && cached ? cached.environment : { agentId: configuration.operatorId,
        variables: { [OPERATOR_MCP_ENVIRONMENT_VARIABLE]: channel ?? issued.token } }
      if (channel) {
        relay ??= await createUnboundWorkerMcpEndpoint({ launcher: appLauncherPath(), signal: new AbortController().signal })
        await relay.bindRelay({ environment, expiresAt: issued.principal.expiresAt,
          request: (body, protocol, signal) => requestAppMcp(this.endpoint, body, issued.token, protocol, signal,
            APP_MCP_TIMEOUTS.tool_timeout_sec * 1000) })
      } else {
        removeRoute = await registerAppRoute(issued.token, this.endpoint, issued.principal.expiresAt)
      }
      signal.throwIfAborted()
      if (manager.harness === 'claude' && !cached) {
        if (!this.deliverClaudeCredential) this.invalidSetup()
        await this.deliverClaudeCredential(manager, configuration, environment, signal)
        signal.throwIfAborted()
      }
      this.credentials.set(conversationId, { environment, ownerId: principalId, configuration: structuredClone(configuration),
        manager, ...(channel ? { channel } : {}), ...(relay ? { relay } : {}),
        ...(removeRoute ? { removeRoute } : {}), principalId: issued.principal.id })
      return environment
    } catch (error) {
      try {
        if (relay === cached?.relay) await relay?.unbindRelay()
        else await relay?.close()
        await removeRoute?.()
      } finally { await this.access.revoke(issued.principal.id) }
      throw error
    }
  }
  async retireTurn(conversationId: string, environment: ChildProcessEnvironment): Promise<boolean> {
    const credential = this.credentials.get(conversationId)
    if (!credential || !isDeepStrictEqual(credential.environment, environment)
      || !credential.channel && !credential.manager.rebindApplicationAccess) return false
    await this.revokeCredentials(conversationId)
    await credential.relay?.unbindRelay()
    await credential.removeRoute?.()
    delete credential.removeRoute
    delete credential.principalId
    return true
  }
  private invalidSetup(): never {
    throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Install and enable Foreman Code MCP in the selected harness before chatting. Add it in Harness Settings for automatic app routing.', 409)
  }
  async release(conversationId: string): Promise<void> {
    const credential = this.credentials.get(conversationId)
    await this.revokeCredentials(conversationId)
    await credential?.relay?.close()
    await credential?.removeRoute?.()
    this.credentials.delete(conversationId)
  }
  private async revokeCredentials(conversationId: string) {
    await this.pool.query(`update management_principals set revoked_at=coalesce(revoked_at,now())
      where id in (select principal_id from operator_chat_credentials where conversation_id=$1)`, [conversationId]) }
  async revokeOrphanedCredentials(): Promise<void> {
    await this.pool.query(`update management_principals set revoked_at=coalesce(revoked_at,now())
      where revoked_at is null and id in (select principal_id from operator_chat_credentials)`)
  }
}
