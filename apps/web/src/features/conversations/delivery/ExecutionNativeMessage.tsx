import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { EngineChatMessageSchema, type EngineChatMessage } from '@foreman-code/contracts'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { AgentChatMessage } from '../agentChat/AgentChatMessage'
import { messageBelongsToExecution, type ExecutionChatSource, type ExecutionChatTarget } from './executionChatSource'
import { nativeMessageAtLeastAsNew } from './nativeMessageWindow'

/** Full bodies are explicit, exact reads and never inflate or replace the bounded streaming window. */
export function ExecutionNativeMessage({ message, target, source, name, onBrowse, onDenied }: {
  message: EngineChatMessage; target: ExecutionChatTarget; source: ExecutionChatSource; name: string
  onBrowse(): void; onDenied(error: Error): void
}) {
  const latest = useRef(message); latest.current = message
  const detail = useQuery({ queryKey: ['execution-chat-message', identityEpoch(), JSON.stringify(target), message.id],
    enabled: false, retry: false, gcTime: 0,
    queryFn: async ({ signal }) => {
      try {
        const full = EngineChatMessageSchema.parse(await source.readMessage(target, latest.current, { signal }))
        signal.throwIfAborted()
        const current = latest.current
        if (!messageBelongsToExecution(full, target) || !nativeMessageAtLeastAsNew(full, current)
          || current.activityNative && JSON.stringify(full.activityNative) !== JSON.stringify(current.activityNative)) {
          throw new Error('This message changed while its full text was loading. Refresh the full message.')
        }
        return full
      } catch (error) { if (error instanceof Error) onDenied(error); throw error }
    } })
  const visible = detail.data && nativeMessageAtLeastAsNew(detail.data, message) ? detail.data : message
  return <AgentChatMessage message={visible} name={name}
    status={<span>{message.provenance.kind === 'consultation' ? `Reply ${message.provenance.binding.consultationId}` : `Execution ${message.provenance.execution.executionId}`}</span>}
    onExpand={async () => { onBrowse(); await detail.refetch({ throwOnError: true }) }} />
}
