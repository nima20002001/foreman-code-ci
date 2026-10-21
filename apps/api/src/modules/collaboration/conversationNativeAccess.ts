import type { AgentChatNativeSessionStart, NativeHarnessSessionManager, NativeSessionStart } from '../harnesses/port.js'
import type { ConversationFeatureContext } from '../conversations/conversationFeatureSubject.js'
import type { ConversationFeatureBinder } from '../conversations/agentChat.js'
import { conversationChatTools } from '../access/conversationCredentials.js'
import type { ConversationCredentials } from '../access/conversationCredentialIssuer.js'
import { DomainError } from '../errors.js'

export class ConversationNativeAccess {
  private readonly bindings = new WeakMap<NativeHarnessSessionManager, {
    context: ConversationFeatureContext; issued: Awaited<ReturnType<ConversationCredentials['issue']>>
  }>()
  constructor(private readonly credentials: ConversationCredentials) {}

  async bind(manager: NativeHarnessSessionManager, context: ConversationFeatureContext) {
    if (!conversationChatTools(context).length) {
      await this.credentials.revoke(context.subject.conversationId)
      return manager
    }
    this.bindings.set(manager, { context, issued: await this.credentials.issue(context) })
    const prepare = (start: NativeSessionStart) => this.prepare(manager, start)
    const create = manager.createSession.bind(manager)
    manager.createSession = (start, signal) => create(prepare(start), signal)
    const attach = manager.attachSession.bind(manager)
    manager.attachSession = (session, start, signal) => attach(session, prepare(start), signal)
    if (manager.forkSession) {
      const fork = manager.forkSession.bind(manager)
      manager.forkSession = (session, start, signal) => fork(session, prepare(start), signal)
    }
    if (manager.startInitialTurn) {
      const initial = manager.startInitialTurn.bind(manager)
      manager.startInitialTurn = (start, input, signal) => initial(prepare(start), input, signal)
    }
    return manager
  }

  prepare(manager: NativeHarnessSessionManager, start: NativeSessionStart): NativeSessionStart {
    const binding = this.bindings.get(manager)
    if (!binding) return start
    const subject = binding.context.subject
    if (start.kind !== 'agent-chat' || start.conversationId !== subject.conversationId
      || start.configuration.id !== subject.agent.configurationVersionId
      || start.workflowId !== subject.agent.workflowId || start.workflowNodeId !== subject.agent.workflowNodeId) {
      throw new DomainError('CHAT_SCOPE_MISMATCH', 'The native launch does not match its conversation credential.', 409)
    }
    return { ...start, environment: binding.issued.environment }
  }

  readonly rebind: ConversationFeatureBinder = async ({ manager, session, context, correlationId, signal }) => {
    if (!conversationChatTools(context).length) {
      await this.credentials.revoke(context.subject.conversationId)
      if (!this.bindings.has(manager)) return
      return { restart: true }
    }
    if (!manager.rebindApplicationAccess) throw new DomainError('CHAT_SUBJECT_BINDING_UNAVAILABLE',
      'This native session cannot refresh its scoped conversation access.', 503)
    const issued = await this.credentials.issue(context)
    const start: AgentChatNativeSessionStart = { kind: 'agent-chat', conversationId: context.subject.conversationId,
      workflowId: context.subject.agent.workflowId, workflowNodeId: context.subject.agent.workflowNodeId,
      correlationId, configuration: context.configuration, workingDirectory: context.workingDirectory,
      environment: issued.environment, instructionsDelivered: true }
    await manager.rebindApplicationAccess(session, start, signal)
    await this.credentials.revoke(context.subject.conversationId, issued.principal.id)
    this.bindings.set(manager, { context, issued })
  }
}
