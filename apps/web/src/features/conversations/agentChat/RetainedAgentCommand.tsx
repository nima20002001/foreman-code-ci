import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ChatDeliveryReceipt, SessionMode } from '@foreman-code/contracts'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import { isApiAccessError } from '../../../shared/api/accessError'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { Button } from '../../../shared/ui/nocturne'
import { ChatDeliveryReceipts } from '../delivery/ChatDeliveryReceipts'
import { chatDeliveryClient } from '../delivery/client'
import { UnavailableChatDraft } from '../delivery/UnavailableChatDraft'
import { sameDeliveryTarget } from '../../workflow-chat/draft'
import type { AgentChatCommand, AgentChatCommandRecord } from './commandRecords'

export function RetainedAgentCommands({ commands, onDenied, onReceipt, pending, draftKey, refresh }: {
  commands: AgentChatCommandRecord[]; onDenied(error: Error): void; pending: boolean; draftKey: string; refresh(): void
  onReceipt(receipt: ChatDeliveryReceipt): void
}) {
  return <><section aria-label="Retained commands">
    <p>{pending ? 'Loading this conversation…' : 'The conversation snapshot is unavailable. Original delivery inputs remain available below.'}</p>
    {commands.map(record => record.command?.kind === 'send' && record.result?.receipt
      ? <RetainedAgentCommand key={record.result.receipt.id} command={record.command} receipt={record.result.receipt}
        onDenied={onDenied} onReceipt={onReceipt} readOnly /> : null)}
  </section><UnavailableChatDraft draftKey={draftKey} pending={pending} onRefresh={refresh} /></>
}

/** A durable command is not a native Message. Keep its original body reachable before owner adoption. */
export function RetainedAgentCommand({ command, receipt, onDenied, onReceipt, onSendAgain, resendReason, readOnly }: {
  command: Extract<AgentChatCommand, { kind: 'send' }>; receipt: ChatDeliveryReceipt
  onDenied?(error: Error): void; onSendAgain?(content: string, attachments?: MessageAttachmentRef[], mode?: SessionMode): void
  onReceipt?(receipt: ChatDeliveryReceipt): void
  resendReason?: string; readOnly: boolean
}) {
  const cache = useQueryClient(), [denied, setDenied] = useState(false)
  const queryKey = ['chat-delivery-receipt', identityEpoch(), JSON.stringify(receipt.target), receipt.id]
  const query = useQuery({ queryKey, initialData: receipt, retry: false, enabled: !denied,
    queryFn: async ({ signal }) => {
      try {
        const response = await chatDeliveryClient.receiptById(receipt.target, receipt.id, { signal })
        signal.throwIfAborted()
        const current = response.receipts.find(value => value.id === receipt.id && value.commandId === command.input.requestId
          && sameDeliveryTarget(value.target, receipt.target))
        if (!current) throw new Error('The original delivery receipt is unavailable.')
        onReceipt?.(current)
        return current
      } catch (error) {
        if (isApiAccessError(error)) {
          setDenied(true); onDenied?.(error)
          void cache.cancelQueries({ queryKey }); cache.removeQueries({ queryKey })
        }
        throw error
      }
    } })
  if (denied) return null
  const current = query.data
  return <article className="agent-chat-message" aria-label="Retained input">
    <p style={{ whiteSpace: 'pre-wrap' }}>{command.input.content}</p>
    {command.input.attachments?.length ? <ul aria-label="Original file revisions">{command.input.attachments.map(pin =>
      <li key={`${pin.fileId}:${pin.revisionId}`}>File {pin.fileId} · Revision {pin.revisionId}</li>)}</ul> : null}
    <ChatDeliveryReceipts receipts={[current]} onRefresh={() => void query.refetch()} />
    {!query.isError && current.state !== 'unknown' ? <Button disabled={query.isFetching}
      onClick={() => void query.refetch()}>Refresh delivery status</Button> : null}
    {query.isError ? <p role="alert">Delivery status could not be refreshed. <Button onClick={() => void query.refetch()}>Retry status</Button></p> : null}
    {!readOnly && onSendAgain && ['failed', 'unknown'].includes(current.state) ? <Button disabled={!!resendReason} title={resendReason}
      onClick={() => onSendAgain(command.input.content, command.input.attachments, command.input.sessionMode)}>
      {current.state === 'failed' ? 'Retry' : 'Send again as new message'}</Button> : null}
  </article>
}
