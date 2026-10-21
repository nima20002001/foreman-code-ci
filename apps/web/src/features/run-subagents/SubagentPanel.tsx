import { InfoHint } from '../../shared/ui/InfoHint'
import { useMemo, useState, type RefObject } from 'react'
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query'
import { createStore, useStore } from 'zustand'
import { SUBAGENT_LIMITS,
  type RunSubagentMessage, type RunSubagentTool, type RunSubagentCommandReceipt } from '@foreman-code/contracts/subagents'
import { Button, CodeBlock, EmptyState, ErrorState, MessageBubble, Spinner, StatusBadge, Tabs, Textarea, ToolCallCard } from '../../shared/ui/nocturne'
import { SubagentPopover } from './SubagentPopover'
import { ApiError } from '../../shared/api/client'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { subagentsApi } from './client'
import { formatBytes, formatClock, providerNames, subagentName, subagentStatus, subagentTiming, toolStatus } from './presentation'
import { subagentsKey, useSubagentDetail, useSubagentMessages, useSubagentTools, type SubagentsScope } from './query'
import type { InteractionResponseValue } from '@foreman-code/contracts'
import { NativeInteractionResponse } from '../../shared/ui/NativeInteractionResponse'

type CommandVariables = { operation: 'input' | 'interrupt' | 'respond'; commandId: string; expectedRevision: string;
  text: string; nativeRequestId?: string; optionId?: string; response?: InteractionResponseValue }

const coverageNote = (coverage: 'complete' | 'partial' | 'unavailable', what: string, provider: string) =>
  coverage === 'partial' ? `Only part of this subagent's ${what} was captured.`
    : coverage === 'unavailable' ? `${provider} doesn't share this subagent's ${what}.` : undefined

/** Plain-language command outcome. Delivery is not completion: the subagent decides what to do with it. */
function receiptText(receipt: RunSubagentCommandReceipt) {
  let what = 'Message'
  if (receipt.operation === 'run_subagent_interrupt_v1') what = 'Interrupt'
  else if (receipt.operation === 'run_subagent_respond_v1') what = 'Response'
  switch (receipt.state) {
    case 'accepted': case 'dispatching': return `${what} is being sent…`
    case 'acknowledged': return `${what} delivered to the subagent.`
    case 'rejected': return `${what} was not delivered.`
    case 'uncertain': return `${what} delivery isn't confirmed yet.`
  }
}

export function SubagentPanel({ scope, subagentId, anchor, onClose }: {
  scope: SubagentsScope; subagentId: string; anchor: RefObject<HTMLElement | null>; onClose: () => void
}) {
  const detail = useSubagentDetail(scope, subagentId)
  const detailBlocked = useBlockingReadError(detail)
  const record = detailBlocked ? undefined : detail.data
  const child = record?.subagent
  const messages = useSubagentMessages(scope, subagentId, Boolean(child))
  const tools = useSubagentTools(scope, subagentId, Boolean(child))
  const messagesBlocked = useBlockingReadError(messages)
  const toolsBlocked = useBlockingReadError(tools)
  const ui = useMemo(() => createStore(() => ({ text: '' })), [])
  const text = useStore(ui, (state) => state.text)
  const [tab, setTab] = useState('messages')
  const queryClient = useQueryClient()
  const mutationKey = [...subagentsKey(scope), subagentId, 'command']
  const commands = useMutationState({ filters: { mutationKey, exact: true }, select: (mutation) => ({
    mutation, status: mutation.state.status, error: mutation.state.error,
    variables: mutation.state.variables as CommandVariables | undefined,
    data: mutation.state.data as RunSubagentCommandReceipt | undefined,
  }) })
  // Keep the last command in Query's mutation cache across closing/reopening the panel.
  // A receipt recheck must never allocate a new command ID after uncertainty.
  const lastCommand = commands.at(-1)
  const command = useMutation({ mutationKey, retry: false, gcTime: 60 * 60_000,
    mutationFn: (input: CommandVariables) => {
      const body = { workspaceId: scope.workspaceId, runId: scope.runId, subagentId, commandId: input.commandId, expectedRevision: input.expectedRevision }
      if (input.operation === 'respond') return subagentsApi.respond({ ...body,
        nativeRequestId: input.nativeRequestId!, optionId: input.optionId!,
        ...(input.response !== undefined ? { response: input.response } : {}) })
      return input.operation === 'input' ? subagentsApi.input({ ...body, text: input.text }) : subagentsApi.interrupt(body)
    },
    onSuccess: (receipt) => {
      if (receipt.state === 'acknowledged') ui.setState({ text: '' })
      void queryClient.invalidateQueries({ queryKey: subagentsKey(scope) })
    },
    onError: () => { void detail.refetch() },
  })
  const pending = lastCommand?.status === 'pending'
  const commandError = lastCommand?.status === 'error'
  const receipt = lastCommand?.data
  const revisionConflict = ApiError.is(lastCommand?.error) && lastCommand.error.code === 'SUBAGENT_REVISION_CONFLICT'
  const unsettled = commandError || Boolean(receipt && ['accepted', 'dispatching', 'uncertain'].includes(receipt.state))
  const allowed = (action: 'sendInput' | 'interrupt') => Boolean(child && child.provider !== 'opencode' && record?.availableActions[action]
    && child.capabilities[action].support === 'supported' && child.capabilities[action].qualification === 'passed')
  const send = (operation: 'input' | 'interrupt') => {
    if (detail.isError || !child || !allowed(operation === 'input' ? 'sendInput' : 'interrupt') || pending || unsettled) return
    command.mutate({ operation, commandId: crypto.randomUUID(), expectedRevision: child.revision, text })
  }
  const recheck = () => { if (lastCommand?.variables) command.mutate(lastCommand.variables) }
  const refresh = async () => {
    const fresh = await detail.refetch()
    if (fresh.isSuccess && lastCommand) { queryClient.getMutationCache().remove(lastCommand.mutation); command.reset() }
  }
  const provider = child ? providerNames[child.provider] : 'Provider'
  const status = child ? subagentStatus(child.status) : undefined
  const messageItems = messagesBlocked ? [] : messages.data?.pages.flatMap((page) => page.items) ?? []
  const toolItems = toolsBlocked ? [] : tools.data?.pages.flatMap((page) => page.items) ?? []
  const canSend = allowed('sendInput'), canInterrupt = allowed('interrupt')
  const footer = child && child.provider !== 'opencode' && (canSend || canInterrupt || receipt || commandError || pending) ? <div className="run-subagent-steer">
    {canSend && <Textarea label="Message to subagent" value={text} maxLength={SUBAGENT_LIMITS.text} rows={2}
      labelHint={child.capabilities.inputTiming === 'idle' ? <InfoHint label="Message to subagent">Delivered when the subagent is waiting for input.</InfoHint> : undefined}
      disabled={pending || unsettled} onChange={(event) => ui.setState({ text: event.currentTarget.value })}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (text.trim()) send('input') } }} />}
    <div className="run-subagent-steer-actions">
      <div className="run-subagent-steer-status" role="status">
        {pending ? <Spinner label="Sending" />
          : revisionConflict ? <span>The subagent changed since you opened it.</span>
          : commandError ? <span role="alert">Couldn't confirm delivery.</span>
          : receipt ? <span data-state={receipt.state}>{receiptText(receipt)}</span> : null}
      </div>
      {revisionConflict ? <Button size="sm" loading={detail.isFetching} onClick={() => void refresh()}>Refresh</Button>
        : unsettled && lastCommand?.variables ? <Button size="sm" disabled={pending} onClick={recheck}>Check again</Button> : null}
      {canInterrupt && <Button variant="danger"
        disabled={detail.isError || pending || unsettled}
        onClick={() => send('interrupt')}>Interrupt</Button>}
      {canSend && <Button variant="primary"
        disabled={detail.isError || !text.trim() || pending || unsettled}
        onClick={() => send('input')}>Send</Button>}
    </div>
  </div> : undefined
  return <SubagentPopover anchor={anchor} title={child ? subagentName(child) : 'Subagent'}
    description={child ? `${provider} subagent` : undefined} busy={pending} onClose={onClose} footer={footer}>
    {detail.isError && (!child || detailBlocked) ? <ErrorState title="Couldn't load this subagent" description={detail.error.message}
      onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
      : !child || !status ? <Spinner label="Loading subagent" /> : <div className="run-subagent-body">
        <section className="run-subagent-summary" aria-label="Status">
          {detail.isError ? <p role="alert">Subagent refresh failed. Showing the last successful read.</p> : null}
          <StatusBadge label={status.label} tone={status.tone} busy={child.status === 'running'} />
          <span>{subagentTiming(child)}</span>
          {child.evidence !== 'confirmed' && <p className="run-subagent-note">This status isn't confirmed yet and may still change.</p>}
          {!canSend && !canInterrupt && !record.availableActions.respond
            && <p className="run-subagent-note">Controls are unavailable for this subagent right now.</p>}
        </section>
        {child.provider !== 'opencode' && record.pendingInteraction ? <section aria-label="Subagent request">
          {record.pendingInteraction.responseOptions.some(option => option.input)
            ? <NativeInteractionResponse key={record.pendingInteraction.turn.nativeRequestId}
              options={record.pendingInteraction.responseOptions}
              disabled={detail.isError || !record.availableActions.respond || pending || unsettled}
              onSelect={(optionId, response) => command.mutate({ operation: 'respond', commandId: crypto.randomUUID(),
                expectedRevision: child.revision, text: '', nativeRequestId: record.pendingInteraction!.turn.nativeRequestId!,
                optionId, ...(response !== undefined ? { response } : {}) })} />
            : record.pendingInteraction.responseOptions.map(option => <Button key={option.optionId}
              disabled={detail.isError || !record.availableActions.respond || pending || unsettled}
              onClick={() => command.mutate({ operation: 'respond', commandId: crypto.randomUUID(),
                expectedRevision: child.revision, text: '', nativeRequestId: record.pendingInteraction!.turn.nativeRequestId!,
                optionId: option.optionId })}>{option.label}</Button>)}
        </section> : null}
        <Tabs label="Subagent activity" value={tab} onValueChange={setTab} items={[
          { value: 'messages', label: 'Messages', ...(messageItems.length ? { badge: `${messageItems.length}${messages.hasNextPage ? '+' : ''}` } : {}), content: <div className="run-subagent-feed">
            {coverageNote(messages.data?.pages.at(-1)?.coverage.transcript ?? child.coverage.transcript, 'conversation', provider) &&
              <p className="run-subagent-note">{coverageNote(messages.data?.pages.at(-1)?.coverage.transcript ?? child.coverage.transcript, 'conversation', provider)}</p>}
            {messages.isError && !messagesBlocked && messages.data ? <p role="alert">Messages refresh failed. <Button size="sm" onClick={() => void messages.refetch()}>Retry messages</Button></p> : null}
            {messagesBlocked || messages.isError && !messages.data ? <ErrorState title="Couldn't load messages" description="Try again in a moment." onRetry={() => void messages.refetch()} retrying={messages.isFetching} />
              : messages.isPending ? <Spinner label="Loading messages" /> : <>
                {messageItems.map((item) => <Message key={item.id} item={item} name={subagentName(child)} />)}
                {!messageItems.length && <EmptyState title="No messages yet" icon="chat" />}
                {messages.hasNextPage && <Button size="sm" loading={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>Load more messages</Button>}
              </>}
          </div> },
          { value: 'tools', label: 'Tool calls', ...(toolItems.length ? { badge: `${toolItems.length}${tools.hasNextPage ? '+' : ''}` } : {}), content: <div className="run-subagent-feed">
            {coverageNote(tools.data?.pages.at(-1)?.coverage.tools ?? child.coverage.tools, 'tool calls', provider) &&
              <p className="run-subagent-note">{coverageNote(tools.data?.pages.at(-1)?.coverage.tools ?? child.coverage.tools, 'tool calls', provider)}</p>}
            {tools.isError && !toolsBlocked && tools.data ? <p role="alert">Tool calls refresh failed. <Button size="sm" onClick={() => void tools.refetch()}>Retry tool calls</Button></p> : null}
            {toolsBlocked || tools.isError && !tools.data ? <ErrorState title="Couldn't load tool calls" description="Try again in a moment." onRetry={() => void tools.refetch()} retrying={tools.isFetching} />
              : tools.isPending ? <Spinner label="Loading tool calls" /> : <>
                {toolItems.map((item) => <Tool key={item.id} item={item} />)}
                {!toolItems.length && <EmptyState title="No tool calls yet" icon="terminal" />}
                {tools.hasNextPage && <Button size="sm" loading={tools.isFetchingNextPage} onClick={() => void tools.fetchNextPage()}>Load more tool calls</Button>}
              </>}
          </div> },
        ]} />
      </div>}
  </SubagentPopover>
}

function Message({ item, name }: { item: RunSubagentMessage; name: string }) {
  return <MessageBubble author={item.role === 'assistant' ? name : 'Parent agent'} role={item.role}
    time={formatClock(item.occurredAt)} dateTime={item.occurredAt} status={!item.final ? <span className="run-subagent-note">writing…</span> : undefined}>
    <p className="run-subagent-text">{item.text}</p>
    {item.truncation.truncated && <p className="run-subagent-note">Shortened — the full message was {formatBytes(item.truncation.originalBytes)}.</p>}
  </MessageBubble>
}

const json = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
function Tool({ item }: { item: RunSubagentTool }) {
  const status = toolStatus(item.status)
  return <ToolCallCard title={item.name} status={status.label} tone={status.tone}
    summary={item.durationMs !== undefined ? `Took ${(item.durationMs / 1000).toFixed(1)}s` : undefined}>
    {item.input !== undefined && <CodeBlock label="Input" code={json(item.input)} language="json" />}
    {item.output !== undefined && <CodeBlock label="Result" code={json(item.output)} />}
    {item.error !== undefined && <CodeBlock label="Error" code={json(item.error)} />}
    {item.truncation.truncated && <p className="run-subagent-note">Shortened — the full record was {formatBytes(item.truncation.originalBytes)}.</p>}
  </ToolCallCard>
}
