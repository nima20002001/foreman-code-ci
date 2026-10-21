import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { ActivitySnapshotV1, InteractionSummary } from '@foreman-code/contracts'
import { ChatDecisionReceipts } from './ChatDecisionReceipts'

afterEach(cleanup)

function snapshot(acknowledged: boolean): ActivitySnapshotV1 {
  const interaction: InteractionSummary = {
    id: 'answer', revision: acknowledged ? '2' : '1',
    owner: { kind: 'chat_request', conversationId: 'chat', requestId: 'question-turn' },
    native: { harness: 'codex', sessionId: 'session', turnId: 'turn', requestId: 'question' },
    delivery: acknowledged ? 'delivered' : 'answer_recorded', answerRecorded: true,
    providerAcknowledged: acknowledged, workerAcknowledged: false, responseAvailability: 'unknown',
  }
  return {
    schemaVersion: 1, scope: { kind: 'operator_chat', conversationId: 'chat' }, revision: interaction.revision,
    active: [], queued: [], latest: null, pendingInteractions: [],
    activities: [{ kind: 'interaction', id: interaction.id, revision: interaction.revision, order: '1',
      owner: interaction.owner, source: { schemaVersion: 1, system: 'management_command_receipt', observedAt: null },
      evidence: 'confirmed', interaction }],
    page: { before: null, nextCursor: null, hasMore: false },
  }
}

it('replaces the unconfirmed warning when a completed answer turn reads back as acknowledged', async () => {
  const onRefresh = vi.fn()
  const { rerender, unmount } = render(<ChatDecisionReceipts snapshot={snapshot(false)} onRefresh={onRefresh} />)
  await userEvent.hover(screen.getByRole('status', { name: 'Decision sending' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Delivery to the provider is not confirmed')
  rerender(<ChatDecisionReceipts snapshot={snapshot(true)} onRefresh={onRefresh} />)
  expect(screen.getByText('Decision delivered')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Refresh decision status' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Delivery to the provider is not confirmed/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Check its status before submitting again/)).not.toBeInTheDocument()
  unmount()
  render(<ChatDecisionReceipts snapshot={snapshot(true)} onRefresh={onRefresh} />)
  await userEvent.hover(screen.getByRole('status', { name: 'Decision delivered' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('The provider acknowledged this decision.')
})

it('keeps an unconfirmed answer visible when readback has no provider acknowledgement', async () => {
  const { rerender } = render(<ChatDecisionReceipts snapshot={snapshot(false)} onRefresh={vi.fn()} />)
  rerender(<ChatDecisionReceipts snapshot={snapshot(false)} onRefresh={vi.fn()} />)
  await userEvent.hover(screen.getByRole('status', { name: 'Decision sending' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Delivery to the provider is not confirmed')
  expect(screen.queryByText('Decision delivered')).not.toBeInTheDocument()
})
