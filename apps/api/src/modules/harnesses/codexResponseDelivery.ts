import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { ApprovalResponseOption, PendingNativeInteraction } from '@foreman-code/contracts'
import { responseValueDigest, type NativeResponseDeliveryEvidence } from '../interactions/delivery.js'
import type { NativeHistory } from './port.js'
import { isObject, type JsonObject } from './codexStdioTransport.js'

/** Approval delivery uses the provider acknowledgement; questions additionally verify their result. */
export function codexResponseDeliveryEvidence(pending: PendingNativeInteraction, option: ApprovalResponseOption,
  nativeResponse: JsonObject, history: NativeHistory): NativeResponseDeliveryEvidence | undefined {
  const request = pending.request
  const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval'].includes(pending.nativeRequestType)
  if (!isObject(request) || !approval && !['item/tool/requestUserInput', 'mcpServer/elicitation/request']
    .includes(pending.nativeRequestType)) return undefined
  const requestId = pending.turn.nativeRequestId
  const events = history.events
  const submitted = events.find(event => event.type === 'interaction.submitted'
    && event.payload.nativeRequestId === requestId && event.payload.optionId === option.optionId
    && event.payload.semantic === option.semantic
    && event.payload.responseDigest === responseValueDigest(option.response))
  if (!submitted?.connectionId) return undefined
  const reserved = events.find(event => event.connectionId === submitted.connectionId
    && event.type === 'interaction.submitting' && event.payload.nativeRequestId === requestId
    && event.payload.optionId === option.optionId
    && event.sequence < submitted.sequence)
  const resolved = events.find(event => event.connectionId === submitted.connectionId
    && event.type === 'interaction.resolved' && event.payload.nativeRequestId === requestId
    && event.payload.submittedOptionId === option.optionId && reserved && event.sequence > reserved.sequence)
  if (!reserved || !resolved) return undefined
  if (approval) {
    const offered = events.find(event => event.connectionId === submitted.connectionId
      && event.type === 'interaction.pending' && event.payload.nativeRequestId === requestId
      && event.payload.nativeRequestType === pending.nativeRequestType
      && event.payload.turnId === pending.turn.nativeTurnId && event.sequence < reserved.sequence)
    if (!offered || resolved.payload.evidence !== 'serverRequest/resolved') return undefined
    // Codex resolves these RPCs after receiving the response, without echoing the decision.
    // Item outcomes may be absent or declined; this acknowledges delivery, not a successful grant or operation.
    return { source: 'provider_acknowledgement', ...pending.session, nativeRequestId: requestId!,
      nativeRequestType: pending.nativeRequestType, optionId: option.optionId, semantic: option.semantic,
      responseDigest: responseValueDigest(option.response) }
  }
  const completed = events.filter(event => event.connectionId === submitted.connectionId
    && event.sequence > resolved.sequence && ['item.completed', 'item.snapshot'].includes(event.type)
    && event.payload.threadId === pending.session.nativeSessionId
    && event.payload.turnId === pending.turn.nativeTurnId)
  let consumed: boolean
  if (pending.nativeRequestType === 'item/tool/requestUserInput') {
    const outputs = completed.flatMap(event => {
      const item = event.payload.item
      return isObject(item) && item.type === 'functionCallOutput' && item.id === request.itemId
        && item.name === 'request_user_input' ? [item] : []
    })
    consumed = outputs.some(item => {
      let output = item.output
      if (Array.isArray(output) && output.length === 1 && isObject(output[0])
        && output[0].type === 'input_text') output = output[0].text
      if (typeof output !== 'string') return false
      try { return canonicalGraphJson(JSON.parse(output)) === canonicalGraphJson(nativeResponse) }
      catch { return false }
    })
    // Blocking questions without a timer can only continue after an answer.
    // Without a tool output, require a resolved submission,
    // a subsequent assistant reply and successful completion of that same turn.
    if (!consumed && outputs.length === 0 && option.input?.kind === 'questions' && request.isBlocking === true
      && request.autoResolutionMs == null && pending.turn.nativeTurnId) {
      const replied = completed.some(event => isObject(event.payload.item)
        && event.payload.item.type === 'agentMessage')
      consumed = replied && events.some(event => {
        if (event.connectionId !== submitted.connectionId || event.sequence <= resolved.sequence
          || event.payload.threadId !== pending.session.nativeSessionId) return false
        if (event.type === 'turn.completed') {
          return event.payload.status === 'completed' && event.payload.turnId === pending.turn.nativeTurnId
        }
        const thread = event.payload.thread
        return event.type === 'thread.reconciled' && isObject(thread)
          && thread.id === pending.session.nativeSessionId && Array.isArray(thread.turns)
          && thread.turns.some(turn => isObject(turn) && turn.id === pending.turn.nativeTurnId
            && turn.status === 'completed')
      })
    }
  } else {
    const started = events.filter(event => event.connectionId === submitted.connectionId
      && event.sequence < reserved.sequence && event.type === 'item.started'
      && event.payload.threadId === pending.session.nativeSessionId
      && event.payload.turnId === pending.turn.nativeTurnId && isObject(event.payload.item)
      && event.payload.item.type === 'mcpToolCall' && event.payload.item.server === request.serverName)
      .filter(event => !events.some(other => other.type === 'item.completed' && other.sequence < reserved.sequence
        && other.connectionId === event.connectionId && isObject(other.payload.item) && isObject(event.payload.item)
        && other.payload.item.id === event.payload.item.id))
    consumed = started.length === 1 && completed.some(event => {
      const item = event.payload.item
      const original = started[0]!.payload.item
      return isObject(item) && isObject(original) && item.id === original.id && item.type === 'mcpToolCall'
        && item.server === request.serverName && item.status === 'completed' && item.result != null && !item.error
    })
    const offered = events.find(event => event.connectionId === submitted.connectionId
      && event.type === 'interaction.pending' && event.payload.nativeRequestId === requestId
      && event.sequence < reserved.sequence)
    consumed ||= Boolean(offered && events.some(event => event.connectionId === submitted.connectionId
      && event.type === 'interaction.readback' && event.payload.nativeRequestId === requestId
      && event.sequence > resolved.sequence && event.payload.threadId === pending.session.nativeSessionId
      && Object.hasOwn(offered.payload, 'observedTurnId') && Object.hasOwn(offered.payload, 'observedTurnStatus')
      && event.payload.observedTurnId === offered.payload.observedTurnId
      && event.payload.observedTurnStatus === offered.payload.observedTurnStatus))
  }
  if (!consumed) return undefined
  return { source: 'provider_history', ...pending.session, nativeRequestId: requestId!,
    nativeRequestType: pending.nativeRequestType, optionId: option.optionId, semantic: option.semantic,
    responseDigest: responseValueDigest(option.response) }
}
