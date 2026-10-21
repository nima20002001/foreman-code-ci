import { create } from 'zustand'
import { z } from 'zod'
import { DeliveryTargetSchema, WorkflowChatPostRequestSchema, type DeliveryTarget, type WorkflowChatPostRequest } from '@foreman-code/contracts'
import { identityChangedEvent, identityEpoch, protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import type { WorkflowChatScope } from './client'

export type WorkflowComposerDraft = Pick<WorkflowChatPostRequest, 'mentions' | 'deliveries' | 'replyToPostId'> & {
  body: string
  draftRevision?: string
  recovery?: { receiptId: string; sourcePostId: string; choice: 'outside_run' | 'historical_follow_up'; sourceTarget: DeliveryTarget }
}
type DraftRecord = Omit<WorkflowComposerDraft, 'body'> & { body: string }
type DraftStore = { records: Record<string, DraftRecord>; scroll: Record<string, number>
  save(key: string, draft: WorkflowComposerDraft): void
  clear(key: string, submitted: WorkflowChatPostRequest, draftRevision?: string): void
  rememberScroll(key: string, top: number): void }
const documentEpoch = identityEpoch()
const empty: WorkflowComposerDraft = { body: '', mentions: [], deliveries: [] }
export const workflowDraftKey = ({ workspaceId, workflowId }: WorkflowChatScope) =>
  `workflow-chat:${workspaceId}:${workflowId}`
const storageKey = (key: string) => protectedKey('draft', `${key}:mentions`)
const usable = () => !sessionIsSwitching() && documentEpoch === identityEpoch()

function loadDraft(key: string): DraftRecord | undefined {
  try {
    const text = window.localStorage.getItem(storageKey(key))
    if (!text) return undefined
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return undefined
    const content = WorkflowChatPostRequestSchema.pick({ body: true, mentions: true, deliveries: true, replyToPostId: true })
      .extend({ body: z.string(), draftRevision: z.string().optional(), recovery: z.object({
        receiptId: z.string(), sourcePostId: z.string(), choice: z.enum(['outside_run', 'historical_follow_up']), sourceTarget: DeliveryTargetSchema,
      }).optional() }).safeParse(parsed)
    if (!content.success) return undefined
    return content.data
  } catch { return undefined /* ignore: the text draft remains in the existing draft store. */ }
}

export const useWorkflowDraftStore = create<DraftStore>((set) => ({
  records: {}, scroll: {},
  save: (key, draft) => {
    if (!usable()) return
    draft = { ...draft, draftRevision: crypto.randomUUID() }
    useConversationDraftStore.getState().setDraft(key, draft.body)
    try { window.localStorage.setItem(storageKey(key), JSON.stringify(draft)) }
    catch { /* ignore: preserve this draft in memory when storage is unavailable. */ }
    set(state => ({ records: { ...state.records, [key]: draft } }))
  },
  clear: (key, submitted, draftRevision) => {
    if (!usable()) return
    set(state => {
      const local = state.records[key], saved = loadDraft(key)
      const draft = saved ?? local
      if (!draftRevision || draft?.draftRevision !== draftRevision || local && local.draftRevision !== draftRevision) return state
      if (!draft || draft.body !== submitted.body || JSON.stringify(draft.mentions) !== JSON.stringify(submitted.mentions)
        || JSON.stringify(draft.deliveries) !== JSON.stringify(submitted.deliveries)
        || draft.replyToPostId !== submitted.replyToPostId) return state
      if (useConversationDraftStore.getState().drafts[key] !== submitted.body) return state
      useConversationDraftStore.getState().setDraft(key, '')
      try { window.localStorage.removeItem(storageKey(key)) }
      catch { /* ignore: the in-memory cleared draft remains authoritative for this view. */ }
      return { records: { ...state.records, [key]: { ...empty } } }
    })
  },
  rememberScroll: (key, top) => set(state => ({ scroll: { ...state.scroll, [key]: top } })),
}))

export function readWorkflowDraft(key: string): WorkflowComposerDraft {
  const body = useConversationDraftStore.getState().drafts[key] ?? ''
  const saved = useWorkflowDraftStore.getState().records[key] ?? loadDraft(key)
  return saved?.body === body ? saved : { ...empty, body }
}

export function sameDeliveryTarget(a: DeliveryTarget, b: DeliveryTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'operator_conversation') {
    return b.kind === 'operator_conversation' && a.conversationId === b.conversationId
  }
  if (b.kind === 'operator_conversation') return false
  if (a.agent.workspaceId !== b.agent.workspaceId || a.agent.workflowId !== b.agent.workflowId
    || a.agent.workflowNodeId !== b.agent.workflowNodeId || a.agent.agentId !== b.agent.agentId) return false
  if (a.kind === 'agent_conversation' && b.kind === a.kind) return a.conversationId === b.conversationId
  if (a.kind === 'workflow_coordinator' && b.kind === a.kind) return a.runId === b.runId && a.waitingActivationId === b.waitingActivationId
  return a.kind === 'workflow_execution' && b.kind === a.kind
    && a.execution.runId === b.execution.runId && a.execution.workflowVersionId === b.execution.workflowVersionId
    && a.execution.executionId === b.execution.executionId && a.execution.attempt === b.execution.attempt
    && a.execution.activationId === b.execution.activationId
}

if (typeof window !== 'undefined') window.addEventListener(identityChangedEvent, () => {
  useWorkflowDraftStore.setState({ records: {}, scroll: {} })
})
