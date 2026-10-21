import { ChatDeliveryReceiptSchema, type ChatDeliveryReceipt } from '@foreman-code/contracts'
import { ApiError } from '../../shared/api/client'

export function confirmedOperatorDelivery(id: string, requestId: string, value: unknown): ChatDeliveryReceipt | undefined {
  if (value === undefined) return undefined
  const parsed = ChatDeliveryReceiptSchema.safeParse(value)
  if (!parsed.success || parsed.data.commandId !== requestId || parsed.data.target.kind !== 'operator_conversation'
    || parsed.data.target.conversationId !== id) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The response did not confirm this exact Operator command and target.' })
  }
  return parsed.data
}
