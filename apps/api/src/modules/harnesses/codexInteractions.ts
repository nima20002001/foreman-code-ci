import { createHash } from 'node:crypto'
import {
  ApprovalResponseOptionSchema,
  CodexSessionCompatibilitySchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION,
  PendingNativeInteractionSchema, type ApprovalResponseOption, type CodexHarnessConfiguration,
  type NativeSessionReference,
  NativeQuestionSchema, NativeInteractionInputSchema, withInteractionResponse,
} from '@foreman-code/contracts'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { isObject, text, type JsonObject, type RequestId, type RpcRequest } from './codexStdioTransport.js'

/** Process-local identity; numeric and string RPC IDs remain distinct. */
export function codexRequestKey(generation: number, id: RequestId): string {
  return `${generation}:${typeof id}:${String(id)}`
}

/** Pure translation of an already schema-validated callback. No callbacks,
 * delivery receipts, grants or durable pending state are reconstructed here. */
export function translateCodexInteraction(context: {
  session: NativeSessionReference; configuration: CodexHarnessConfiguration; connectionId: string; generation: number
}, request: RpcRequest) {
  const params = request.params ?? {}
  const turnId = text(params.turnId)
  const standalone = request.method === 'mcpServer/elicitation/request' && params.turnId == null
  if ((!turnId && !standalone) || params.threadId !== context.session.nativeSessionId) return undefined
  // Native RPC IDs may repeat after cold attach; connection identity fences new opaque IDs.
  const nativeRequestId = `${context.session.nativeSessionId}:${turnId}:${request.method}:${context.connectionId}:${codexRequestKey(context.generation, request.id)}`
  const responses: Map<string, { option: ApprovalResponseOption; nativeResponse: JsonObject }> = new Map()
  const add = (option: Omit<ApprovalResponseOption, 'optionId'>, nativeResponse: JsonObject) => {
    if ((context.configuration.advanced?.sessionPersistence ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION.sessionPersistence) === 'ephemeral' && option.semantic === 'allow_session') return
    const optionId = `codex-${createHash('sha256').update(canonicalJsonNumericKeysFirstLegacy([nativeRequestId, nativeResponse])).digest('hex').slice(0, 24)}`
    // Empty optional descriptions are omitted rather than violating the shared schema.
    const { scopeSummary, ...rest } = option
    const parsed = ApprovalResponseOptionSchema.parse({ optionId, ...rest, ...(scopeSummary?.trim() ? { scopeSummary } : {}) })
    responses.set(optionId, { option: parsed, nativeResponse })
  }
  if (request.method === 'item/commandExecution/requestApproval') {
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : ['accept', 'acceptForSession', 'decline', 'cancel']
    for (const decision of decisions) addCommandDecision(add, decision)
  } else if (request.method === 'item/fileChange/requestApproval') {
    add(simpleOption('approve_once', 'Approve once', 'request'), { decision: 'accept' })
    add(simpleOption('allow_session', 'Allow for this session', 'session'), { decision: 'acceptForSession' })
    add(simpleOption('reject', 'Reject', 'request'), { decision: 'decline' })
    add(simpleOption('cancel', 'Cancel turn', 'request', true), { decision: 'cancel' })
  } else if (request.method === 'item/permissions/requestApproval') {
    if (!isObject(params.permissions)) return undefined
    add(simpleOption('allow_turn', 'Allow for this turn', 'turn'), { permissions: params.permissions, scope: 'turn' })
    add(simpleOption('allow_session', 'Allow for this session', 'session'), { permissions: params.permissions, scope: 'session' })
    add(simpleOption('reject', 'Reject', 'request'), { permissions: {}, scope: 'turn' })
  } else if (request.method === 'item/tool/requestUserInput') {
    const questions = Array.isArray(params.questions) ? params.questions : []
    const question = questions.length === 1 && isObject(questions[0]) ? questions[0] : undefined
    const qualifiedChoices: Record<string, Omit<ApprovalResponseOption, 'optionId'>> = {
      Allow: simpleOption('approve_once', 'Allow', 'request'),
      'Allow for this session': simpleOption('allow_session', 'Allow for this session', 'session'),
      "Allow and don't ask me again": {
        ...simpleOption('persistent_policy_change', "Allow and don't ask me again", 'persistent_config'),
        mutatesPersistentPolicy: true,
      },
      Cancel: simpleOption('cancel', 'Cancel this tool call', 'request'),
    }
    const choices = Array.isArray(question?.options) ? question.options.filter(isObject) : []
    const approvalQuestion = question && text(question.id)?.startsWith('mcp_tool_call_approval_')
      && question.header === 'Approve app tool call?' && question.isOther === false && question.isSecret === false
      && params.isBlocking === true && Array.isArray(question.options) && choices.length === question.options.length
      && choices.some((choice) => choice.label === 'Allow') && choices.some((choice) => choice.label === 'Cancel')
      && choices.every((choice) => typeof choice.label === 'string' && Object.hasOwn(qualifiedChoices, choice.label))
    if (approvalQuestion) {
      for (const choice of choices) {
        const label = String(choice.label)
        add({ ...qualifiedChoices[label]!, ...(typeof choice.description === 'string' ? { scopeSummary: choice.description } : {}) },
          { answers: { [String(question.id)]: { answers: [label] } } })
      }
    } else {
      add({ ...simpleOption('approve_once', 'Submit answers', 'request'),
        input: { kind: 'questions', questions: NativeQuestionSchema.array().parse(questions) } }, {})
    }
  } else if (request.method === 'mcpServer/elicitation/request') {
    let content: JsonObject | null
    if (params.mode === 'url' && text(params.url) && text(params.elicitationId)) content = null
    else if (['form', 'openai/form', 'openaiForm'].includes(String(params.mode))
      && (isObject(params.requestedSchema) || typeof params.requestedSchema === 'boolean')) {
      content = {}
    } else return undefined
    const formInput = content !== null
      ? NativeInteractionInputSchema.parse({ kind: 'form', schema: params.requestedSchema }) : undefined
    add({ ...simpleOption('approve_once', params.mode === 'url' ? 'Confirm authorization completed' : 'Accept', 'request'),
      ...(formInput ? { input: formInput } : {}),
      ...(typeof params.url === 'string' && params.url.trim() ? { scopeSummary: params.url } : {}) }, { action: 'accept', content, _meta: null })
    // Pinned native MCP approval metadata explicitly advertises persistence.
    if (content !== null && isObject(params._meta) && params._meta.codex_approval_kind === 'mcp_tool_call') {
      const offered = Array.isArray(params._meta.persist) ? params._meta.persist : [params._meta.persist]
      if (offered.includes('session')) add({ ...simpleOption('allow_session', 'Allow for this session', 'session'),
        ...(formInput ? { input: formInput } : {}) },
        { action: 'accept', content: {}, _meta: { persist: 'session' } })
      if (offered.includes('always')) add({
        ...simpleOption('persistent_policy_change', "Allow and don't ask me again", 'persistent_config'),
        ...(formInput ? { input: formInput } : {}),
        mutatesPersistentPolicy: true,
      }, { action: 'accept', content: {}, _meta: { persist: 'always' } })
    }
    add(simpleOption('reject', 'Decline', 'request'), { action: 'decline', content: null, _meta: null })
    add(simpleOption('cancel', 'Cancel request', 'request'), { action: 'cancel', content: null, _meta: null })
  } else return undefined
  if (responses.size === 0) return undefined
  const options = [...responses.values()].map((value) => value.option)
  CodexSessionCompatibilitySchema.parse({ configuration: context.configuration, responseOptions: options })
  const pending = PendingNativeInteractionSchema.parse({
    session: context.session, turn: { ...(turnId ? { nativeTurnId: turnId } : {}), nativeRequestId },
    nativeRequestType: request.method, request: params, responseOptions: options,
  })
  return { pending, responses }
}

/** The offered input schema remains owned by the pending native callback. */
export function resolveCodexInteractionResponse(
  stored: { option: ApprovalResponseOption; nativeResponse: JsonObject }, selected: ApprovalResponseOption,
): JsonObject {
  const option = withInteractionResponse(stored.option, selected.response)
  if (option.input?.kind === 'questions') return { answers: option.response }
  if (option.input?.kind === 'form') return { ...stored.nativeResponse, content: option.response }
  return stored.nativeResponse
}

function addCommandDecision(
  add: (option: Omit<ApprovalResponseOption, 'optionId'>, response: JsonObject) => void, decision: unknown,
): void {
  if (decision === 'accept') add(simpleOption('approve_once', 'Approve once', 'request'), { decision })
  else if (decision === 'acceptForSession') add(simpleOption('allow_session', 'Allow for this session', 'session'), { decision })
  else if (decision === 'decline') add(simpleOption('reject', 'Reject', 'request'), { decision })
  else if (decision === 'cancel') add(simpleOption('cancel', 'Cancel turn', 'request', true), { decision })
  else if (isObject(decision) && isObject(decision.acceptWithExecpolicyAmendment)) {
    add({ ...simpleOption('persistent_policy_change', 'Allow and save command policy', 'persistent_config'),
      scopeSummary: canonicalJsonNumericKeysFirstLegacy(decision.acceptWithExecpolicyAmendment), mutatesPersistentPolicy: true }, { decision })
  } else if (isObject(decision) && isObject(decision.applyNetworkPolicyAmendment)) {
    const amendment = isObject(decision.applyNetworkPolicyAmendment.network_policy_amendment)
      ? decision.applyNetworkPolicyAmendment.network_policy_amendment : decision.applyNetworkPolicyAmendment
    add({ ...simpleOption('persistent_policy_change', `Save network ${String(amendment.action ?? 'policy')} rule for ${String(amendment.host ?? 'the offered target')}`, 'persistent_config'),
      scopeSummary: canonicalJsonNumericKeysFirstLegacy(amendment), mutatesPersistentPolicy: true }, { decision })
  }
}

function simpleOption(
  semantic: ApprovalResponseOption['semantic'], label: string,
  persistence: ApprovalResponseOption['persistence'], interruptsCurrentTurn = false,
): Omit<ApprovalResponseOption, 'optionId'> {
  return { semantic, label, persistence, affectsOtherPendingRequests: false, interruptsCurrentTurn, mutatesPersistentPolicy: false }
}
