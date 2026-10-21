import { EngineChatMessageSchema, WorkflowExecutionChatMessageRequestSchema,
  WorkflowExecutionChatChangeSchema } from '@foreman-code/contracts'
import { apiClient, ApiError } from '../../../shared/api/client'
import { assertSession, sessionGeneration, sessionSignal, sessionIsSwitching } from '../../../shared/api/sessionBoundary'
import { sameDeliveryTarget } from '../../workflow-chat/draft'
import type { ExecutionChatSource, ExecutionChatTarget } from './executionChatSource'

function path(target: ExecutionChatTarget) {
  return `/api/workspaces/${encodeURIComponent(target.agent.workspaceId)}`
    + `/workflows/${encodeURIComponent(target.agent.workflowId)}/execution-chat`
}

export const productionExecutionChatSource: ExecutionChatSource = {
  subscribe(target, receive, options) {
    if (sessionIsSwitching() || typeof EventSource === 'undefined') return () => {}
    const generation = sessionGeneration()
    const identitySignal = sessionSignal()
    const source = new EventSource(`${path(target)}/events?${new URLSearchParams({ target: JSON.stringify(target) })}`)
    let closed = false
    let cursor: string | undefined
    const valid = () => {
      try { assertSession(generation); return !closed && !options.signal.aborted && !identitySignal.aborted }
      catch { return false }
    }
    const close = () => {
      closed = true
      source.close()
      options.signal.removeEventListener('abort', close)
      identitySignal.removeEventListener('abort', close)
    }
    source.addEventListener('changed', event => {
      if (!valid()) return
      try {
        const change = WorkflowExecutionChatChangeSchema.parse(JSON.parse((event as MessageEvent<string>).data))
        if (!sameDeliveryTarget(target, change.target)) throw new Error('Chat stream target changed')
        if (cursor !== change.cursor) { cursor = change.cursor; receive(change) }
      } catch (error) { options.error(error instanceof Error ? error : new Error('Invalid chat stream event')) }
    })
    source.addEventListener('open', () => { if (valid()) options.reconnect() })
    source.addEventListener('error', () => { if (valid()) options.error(new Error('Chat stream disconnected')) })
    source.addEventListener('unavailable', () => {
      if (!valid()) return
      close()
      options.error(new ApiError({ code: 'ACCESS_DENIED', message: 'This Run chat is unavailable.' }, 403))
    })
    options.signal.addEventListener('abort', close, { once: true })
    identitySignal.addEventListener('abort', close, { once: true })
    if (options.signal.aborted || identitySignal.aborted) close()
    return close
  },
  readMessage(target, message, options) {
    return apiClient.request(`${path(target)}/message`, EngineChatMessageSchema, { ...options, method: 'POST',
      body: WorkflowExecutionChatMessageRequestSchema.parse({ target, messageId: message.id }) })
  },
}
