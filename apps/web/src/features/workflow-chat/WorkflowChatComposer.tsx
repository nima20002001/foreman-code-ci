import { useEffect, useId, useRef, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useChatOnline } from '../conversations/delivery/useChatDelivery'
import type { AgentIdentity, WorkflowChatPostRequest } from '@foreman-code/contracts'
import { Button, Textarea } from '../../shared/ui/nocturne'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { readWorkflowDraft, useWorkflowDraftStore, workflowDraftKey, type WorkflowComposerDraft } from './draft'
import { agentLabel, editMentionSpans, insertMention, mentionQuery } from './mentions'
import { RecipientTargetPicker, type RecipientTargetOption, type WorkflowTargetResolver } from './RecipientTargetPicker'
import { recipientProblem } from './recipientProblem'
import type { WorkflowChatScope } from './client'

export function WorkflowChatComposer({ scope, participants, participantsLoading, participantsError, retryParticipants,
  resolveTargets, onSubmit, pending, unavailable, draftKey }: {
  scope: WorkflowChatScope
  participants: readonly AgentIdentity[]
  participantsLoading?: boolean
  participantsError?: string
  retryParticipants?: () => void
  resolveTargets: WorkflowTargetResolver
  onSubmit(request: Omit<WorkflowChatPostRequest, 'commandId'>): void
  pending?: boolean
  unavailable?: string
  draftKey?: string
}) {
  const key = draftKey ?? workflowDraftKey(scope), epoch = identityEpoch()
  const online = useChatOnline()
  useConversationDraftStore(store => store.drafts[key])
  useWorkflowDraftStore(store => store.records[key])
  const draft = readWorkflowDraft(key)
  const save = (next: WorkflowComposerDraft) => useWorkflowDraftStore.getState().save(key, next)
  const input = useRef<HTMLTextAreaElement>(null), id = useId()
  const [caret, setCaret] = useState(draft.body.length), [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const query = !dismissed ? mentionQuery(draft.body, caret) : undefined
  const suggestions = query ? participants.filter(agent => agent.displayName.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())) : []
  const mentioned = [...new Set(draft.mentions.map(mention => mention.workflowNodeId))]
  const agents = mentioned.map(nodeId => participants.find(agent => agent.workflowNodeId === nodeId))
  const results = useQueries({ queries: agents.map((agent, index) => ({
    queryKey: ['workflow-chat-targets', epoch, scope.workspaceId, scope.workflowId, mentioned[index], agent?.configurationVersionId,
      draft.recovery?.receiptId, draft.recovery?.choice],
    enabled: !!agent, retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const options = await resolveTargets(agent!, { signal, recovery: draft.recovery?.choice, sourceTarget: draft.recovery?.sourceTarget })
      return options.filter(option => option.target.kind !== 'operator_conversation'
        && option.target.agent.workspaceId === scope.workspaceId && option.target.agent.workflowId === scope.workflowId
        && option.target.agent.workflowNodeId === agent!.workflowNodeId
        && (!draft.recovery || option.target.kind === 'agent_conversation'))
    },
  })) })
  const chooseTarget = (nodeId: string, option: RecipientTargetOption) => {
    const current = readWorkflowDraft(key)
    if (!current.mentions.some(mention => mention.workflowNodeId === nodeId) || option.target.kind === 'operator_conversation') return
    const previous = current.deliveries.find(delivery => delivery.workflowNodeId === nodeId)
    save({ ...current, deliveries: [...current.deliveries.filter(delivery => delivery.workflowNodeId !== nodeId), {
      workflowNodeId: nodeId, target: option.target, intent: previous?.intent ?? 'auto',
      ...(option.presentation.nativeTurnId ? { expectedNativeTurnId: option.presentation.nativeTurnId } : {}),
    }] })
  }
  useEffect(() => {
    mentioned.forEach((nodeId, index) => {
      if (!readWorkflowDraft(key).deliveries.some(delivery => delivery.workflowNodeId === nodeId)
        && results[index]?.data?.length === 1) chooseTarget(nodeId, results[index].data![0]!)
    })
  })
  const add = (agent: AgentIdentity, atQuery = true) => {
    const current = readWorkflowDraft(key)
    const added = insertMention(current.body, current.mentions, agent,
      atQuery && query ? query.start : current.body.length, atQuery && query ? query.end : current.body.length)
    save({ ...current, body: added.body, mentions: added.mentions })
    setCaret(added.caret); setDismissed(true); setHighlight(0)
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(added.caret, added.caret) })
  }
  const edit = (body: string, position: number) => {
    const mentions = editMentionSpans(draft.body, body, draft.mentions)
    const nodes = new Set(mentions.map(mention => mention.workflowNodeId))
    save({ ...draft, body, mentions, deliveries: draft.deliveries.filter(delivery => nodes.has(delivery.workflowNodeId)) })
    setCaret(position); setDismissed(false); setHighlight(0)
  }
  const issue = unavailable ?? (mentioned.length > 32 ? 'Mention up to 32 agents per post.'
    : agents.some(agent => !agent) ? 'A mentioned agent is no longer available. Remove that recipient.'
      : results.map((result, index) => recipientProblem(draft.deliveries.find(delivery => delivery.workflowNodeId === mentioned[index]), result)).find(Boolean))
  const bytes = new TextEncoder().encode(draft.body).byteLength
  const submit = () => {
    if (pending || issue || !draft.body.trim() || bytes > 16 * 1024 || !online) return
    onSubmit({ workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      body: draft.body, mentions: draft.mentions, deliveries: draft.deliveries,
      cardIds: [], ...(draft.replyToPostId ? { replyToPostId: draft.replyToPostId } : {}) })
  }
  const master = participants.find(agent => agent.productRole === 'master')
  return <form className="workflow-chat-composer" aria-label="Workflow message composer"
    onSubmit={event => { event.preventDefault(); submit() }}>
    {draft.recovery ? <p role="status">Reply will appear in Group chat. Recovering one recipient from post {draft.recovery.sourcePostId}.</p> : null}
    {draft.replyToPostId && !draft.recovery ? <p>Reply to post {draft.replyToPostId}</p> : null}
    <Textarea ref={input} label="Message this workflow" value={draft.body} rows={3} id={id}
      role="combobox" aria-expanded={!!query} aria-controls={`${id}-mentions`} aria-autocomplete="list"
      aria-activedescendant={query && suggestions[highlight] ? `${id}-option-${highlight}` : undefined}
      onChange={event => edit(event.target.value, event.target.selectionStart)}
      onSelect={event => setCaret(event.currentTarget.selectionStart)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        if (query) {
          if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); setHighlight(current => Math.max(0, Math.min(suggestions.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))); return
          }
          if (event.key === 'Enter') { event.preventDefault(); if (suggestions[highlight]) add(suggestions[highlight]!); return }
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); submit() }
      }} />
    {query ? <div id={`${id}-mentions`} role="listbox" aria-label="Mention an agent">
      {participantsLoading ? <p>Loading targets…</p> : participantsError ? <p>Could not load targets. <Button onClick={retryParticipants}>Retry</Button></p>
        : suggestions.length ? suggestions.map((agent, index) => <div role="option" tabIndex={-1} id={`${id}-option-${index}`}
          aria-selected={highlight === index} key={agent.workflowNodeId} onMouseDown={event => event.preventDefault()}
          onClick={() => add(agent)}>{agentLabel(agent)}</div>) : <p>No matching agents.</p>}
    </div> : null}
    <p>Mention an agent to ask it to act. Posts without a resolved mention do not start work.</p>
    {master ? <Button size="sm" type="button" onClick={() => add(master, false)}>Ask master</Button> : null}
    {mentioned.map((nodeId, index) => {
      const agent = agents[index]
      const remove = () => save({ ...draft, mentions: draft.mentions.filter(mention => mention.workflowNodeId !== nodeId),
        deliveries: draft.deliveries.filter(delivery => delivery.workflowNodeId !== nodeId) })
      return agent ? <RecipientTargetPicker key={nodeId} agent={agent} result={results[index]!}
        selection={draft.deliveries.find(delivery => delivery.workflowNodeId === nodeId)} onSelect={option => chooseTarget(nodeId, option)}
        onIntent={intent => save({ ...draft, deliveries: draft.deliveries.map(delivery => delivery.workflowNodeId === nodeId ? { ...delivery, intent } : delivery) })}
        onRemove={remove} /> : <p key={nodeId}>Agent {nodeId} is unavailable. <Button onClick={remove}>Remove recipient</Button></p>
    })}
    {issue ? <p role="status">{issue}</p> : null}
    {bytes > 16 * 1024 ? <p role="alert">Message is too large. The limit is 16 KiB of UTF-8 text.</p> : null}
    {!online ? <p role="status">You are offline. Your draft is kept.</p> : null}
    <Button type="submit" variant="primary" loading={pending} disabled={pending || !!issue || !draft.body.trim() || bytes > 16 * 1024 || !online}>Post</Button>
  </form>
}
