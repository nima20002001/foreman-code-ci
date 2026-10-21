import { useQuery } from '@tanstack/react-query'
import type { OperatorConversationSummary } from '@foreman-code/contracts'
import { getOperatorConversation } from '../../shared/api/client'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { ActionMenu } from '../../shared/ui/nocturne'
import { retiredHarnessLabel } from '../settings/settingsPresentation'

export function OperatorHistoryActions({ summary, queryKey, enabled, removing, onRemove }: {
  summary: OperatorConversationSummary
  queryKey: readonly unknown[]
  enabled: boolean
  removing: boolean
  onRemove(): void
}) {
  // Summaries omit the immutable harness. Reuse the detail cache before offering a write.
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: ({ signal }) => getOperatorConversation(summary.conversationId, { signal }),
    select: state => state.settings?.harness,
    staleTime: Infinity,
    retry: false,
    retryOnMount: false,
  })
  const denied = useAccessFailureLatch(query)
  if (!enabled || denied || !query.isSuccess) return null
  if (query.data === 'opencode') return <span>{retiredHarnessLabel}</span>
  return <ActionMenu width={120} label={`Chat options: ${summary.title ?? 'Conversation'}`}
    className="operator-chat-row-menu" items={[
      { id: 'delete', label: 'Delete', danger: true,
        disabled: Boolean(summary.activeRequestId) || !['idle', 'error'].includes(summary.turnState) || removing,
        ...(summary.activeRequestId ? { description: 'Stop the response before deleting.' } : {}),
        onSelect: onRemove },
    ]} />
}
