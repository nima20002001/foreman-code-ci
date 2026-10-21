import type { Dispatch, SetStateAction } from 'react'
import { sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import type { listOperatorConversationSummaries } from '../../shared/api/operatorChatSummaries'
import type { OperatorChatConnection } from '../../shared/api/operatorChatStream'
import type { OperatorTextProjection } from './operatorTextProjection'
import type { useOperatorChatStore } from './operatorChatStore'

export const listKey = ['operator-chat', 'summaries'] as const
export const detailKey = (id: string) => ['operator-chat', 'conversation', id] as const
export type Summaries = Awaited<ReturnType<typeof listOperatorConversationSummaries>>
export type AppRequest = NonNullable<ReturnType<typeof useOperatorChatStore.getState>['request']>
export type AskSend = {
  id: string; requestId: string; content: string; generation: number; navigationGeneration: number; ready: boolean
}
export type PartialState = { conversationId: string; value?: OperatorTextProjection } | undefined
export type PreparationError = { id: string; message: string } | undefined
export type ConnectionState = { id: string; state: OperatorChatConnection } | undefined
export type RefreshOutbox = Dispatch<SetStateAction<number>>
export function currentSession(generation: number): boolean {
  return !sessionIsSwitching() && sessionGeneration() === generation
}
