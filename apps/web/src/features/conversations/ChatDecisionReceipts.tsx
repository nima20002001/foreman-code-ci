import type { ActivitySnapshotV1, InteractionSummary } from '@foreman-code/contracts'
import { Check, CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react'
import { IconButton, Tooltip } from '../../shared/ui/nocturne'
import './chatDecisionReceipts.css'

function decisionLabel(receipt: InteractionSummary) {
  if (receipt.providerAcknowledged) return 'Decision delivered'
  if (receipt.delivery === 'uncertain') return 'Decision delivery unconfirmed'
  if (receipt.delivery === 'failed') return 'Decision delivery failed'
  return 'Decision sending'
}

export function ChatDecisionReceipts({ snapshot, onRefresh, pending = false }: {
  snapshot?: ActivitySnapshotV1; onRefresh(): void; pending?: boolean
}) {
  const receipts = [...new Map([
    ...(snapshot?.activities.flatMap(item => item.kind === 'interaction' ? [item.interaction] : []) ?? []),
    ...(snapshot?.pendingInteractions ?? []),
  ].map(receipt => [receipt.id, receipt])).values()]
    .filter(receipt => receipt.answerRecorded || receipt.providerAcknowledged)
  if (!receipts.length && !snapshot?.hasMorePendingInteractions) return null
  // Delivered decisions need no action; refresh only while one is unconfirmed.
  const needsAttention = receipts.some(receipt => !receipt.providerAcknowledged)
  return <section className="chat-decision-receipts" aria-label="Recorded decisions">
    {receipts.map(receipt => {
      const label = decisionLabel(receipt)
      const delivery = receipt.providerAcknowledged ? 'The provider acknowledged this decision.'
        : 'Delivery to the provider is not confirmed. Your decision is saved. Check its status before submitting again.'
      const detail = `${delivery} ${receipt.workerAcknowledged ? 'The worker acknowledged it.' : 'This does not confirm work completion.'}
Request: ${receipt.native?.requestId ?? receipt.id}${receipt.owner.kind === 'chat_request' ? ` · Message request: ${receipt.owner.requestId}` : ''}`
      let glyph = <LoaderCircle size={12} aria-hidden="true" />
      if (receipt.providerAcknowledged) glyph = <Check size={12} aria-hidden="true" />
      else if (receipt.delivery === 'uncertain' || receipt.delivery === 'failed') glyph = <CircleAlert size={12} aria-hidden="true" />
      return <Tooltip key={receipt.id} content={detail}>
        <span className="chat-decision-state" tabIndex={0} role="status" aria-label={label}>
          {glyph}<span>{label}</span>
        </span>
      </Tooltip>
    })}
    {snapshot?.hasMorePendingInteractions ? <Tooltip content="Some older decisions are outside this view">
      <span tabIndex={0} aria-label="More recorded decisions">…</span>
    </Tooltip> : null}
    {needsAttention || snapshot?.hasMorePendingInteractions ? <Tooltip content="Refresh decision status">
      <IconButton size="sm" variant="ghost" label="Refresh decision status" disabled={pending} onClick={onRefresh}>
        <RotateCcw size={12} aria-hidden="true" />
      </IconButton>
    </Tooltip> : null}
  </section>
}
