import { http, HttpResponse } from 'msw'
import { screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { ChatSendRequestSchema, ChatStopRequestSchema, ChatQueueCancelRequestSchema,
  type ChatDeliveryReceipt, type ChatSendRequest } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { ApiError, getOperatorConversation, sendOperatorMessage, cancelOperatorTurn } from '../../shared/api/client'

/** Typed HTTP fake for C0's canonical owner, backed by the existing public Operator test adapter. */
export function installCanonicalOperatorFixture() {
  const commands = new Map<string, ChatSendRequest>(), receipts = new Map<string, ChatDeliveryReceipt>()
  const root = '/api/operator/conversations/:conversationId/deliveries'
  const receipt = (command: ChatSendRequest): ChatDeliveryReceipt => ({ id: `receipt-${command.commandId}`, commandId: command.commandId!,
    target: command.target, requestedIntent: command.intent, appliedIntent: command.intent === 'auto' ? 'next_turn' : command.intent,
    state: 'accepted', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
  const failure = (error: unknown) => HttpResponse.json({ code: ApiError.is(error) ? error.code : 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : 'Unavailable' }, { status: ApiError.is(error) && error.status >= 400 ? error.status : 503 })
  server.use(
    http.post(`${root}/read`, async ({ params, request }) => {
      try {
        const id = String(params.conversationId), state = await getOperatorConversation(id)
        const input = await request.json() as { commandId?: string; receiptId?: string; deliveryInputs?: { receiptId?: string } }
        const target = { kind: 'operator_conversation' as const, conversationId: id }
        if (input.deliveryInputs) return HttpResponse.json({ target, deliveryInputs: {
          items: [...commands.values()].filter(command => command.target.kind === 'operator_conversation'
            && command.target.conversationId === id && (!input.deliveryInputs?.receiptId || receipts.get(command.commandId!)?.id === input.deliveryInputs.receiptId))
            .filter(command => receipts.has(command.commandId!)).map(command => ({ commandId: command.commandId,
              receiptId: receipts.get(command.commandId!)!.id, target, origin: 'direct', content: command.content,
              attachments: command.attachments ?? [], intent: command.intent, createdAt: '2026-10-01T00:00:00Z', truncated: false, bodyCursor: null })),
          nextCursor: null, hasMore: false, revision: state.revision,
        } })
        if (input.commandId || input.receiptId) {
          const command = input.commandId ? commands.get(input.commandId) : undefined
          if (command && state.messages.some(message => message.requestId === command.commandId)) receipts.set(command.commandId!, receipt(command))
          const found = [...receipts.values()].filter(item => input.receiptId ? item.id === input.receiptId : item.commandId === input.commandId)
          return found.length ? HttpResponse.json({ target, receipts: found })
            : HttpResponse.json({ code: 'CHAT_RECEIPT_NOT_FOUND', message: 'No retained receipt.' }, { status: 404 })
        }
        const active = !!state.activeRequestId, claude = state.settings?.harness === 'claude'
        return HttpResponse.json({ target, state, receipts: [...receipts.values()].filter(item => item.target.kind === 'operator_conversation' && item.target.conversationId === id),
          delivery: { state: state.turnState === 'canceling' ? 'settling' : active ? 'active' : 'idle',
            capabilities: { steer: claude ? 'unavailable' : 'native_expected_turn', queue: true, interruptAndSend: true },
            ...(active && !claude ? { nativeTurnId: 'fixture-native-turn' } : {}) } })
      } catch (error) { return failure(error) }
    }),
    http.post(`${root}/send`, async ({ params, request }) => {
      try {
        const command = ChatSendRequestSchema.parse(await request.json()); commands.set(command.commandId!, command)
        const state = await getOperatorConversation(String(params.conversationId))
        await sendOperatorMessage(String(params.conversationId), { requestId: command.commandId!, content: command.content,
          ...(state.settings && state.settings.harness !== 'opencode' ? { settings: state.settings } : {}), forkExpectedRevision: state.revision,
          configurationVersionId: state.conversation.operatorConfigurationVersionId,
          ...(command.attachments ? { attachments: command.attachments } : {}), ...(command.sessionMode ? { sessionMode: command.sessionMode } : {}) })
        const saved = receipt(command); receipts.set(saved.commandId, saved); return HttpResponse.json(saved)
      } catch (error) { return failure(error) }
    }),
    http.post(`${root}/stop`, async ({ params, request }) => {
      try {
        const command = ChatStopRequestSchema.parse(await request.json()), id = String(params.conversationId)
        const state = await getOperatorConversation(id)
        if (state.activeRequestId) await cancelOperatorTurn(id, state.activeRequestId)
        return HttpResponse.json({ commandId: command.commandId, target: command.target, operation: 'stop_active', state: 'completed', affectedReceiptIds: [], replayed: false })
      } catch (error) { return failure(error) }
    }),
    http.post(`${root}/cancel`, async ({ request }) => {
      const command = ChatQueueCancelRequestSchema.parse(await request.json())
      const affected = [...receipts.values()].filter(item => item.state === 'queued'
        && (command.selection.kind === 'all' || item.id === command.selection.receiptId))
      for (const item of affected) receipts.set(item.commandId, { ...item, state: 'canceled' })
      return HttpResponse.json({ commandId: command.commandId, target: command.target,
        operation: command.selection.kind === 'all' ? 'cancel_all_queued' : 'cancel_one', state: 'completed',
        affectedReceiptIds: affected.map(item => item.id), replayed: false })
    }),
  )
  return { commands, receipts }
}

/** The draft stays editable while the selected chat loads, in a textbox the loaded composer then replaces.
 * Wait for the loaded composer before holding on to its textbox or its Send button. */
export async function findOperatorComposer() {
  await waitFor(() => expect(screen.queryByText(/Loading the selected chat/)).not.toBeInTheDocument())
  return screen.findByRole('textbox', { name: 'Message' })
}
