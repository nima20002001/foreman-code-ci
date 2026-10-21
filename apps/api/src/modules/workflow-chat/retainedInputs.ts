import type { DeliveryTarget } from '@foreman-code/contracts'
import type { ReadAgentChatRequestSchema, ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import type { z } from 'zod'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { DomainError } from '../errors.js'
import type { StoredDelivery } from './model.js'
import { CHANNEL_PAGE_BYTES, decodeCursor, encodeCursor, pageLimit } from './validation.js'
import type { PostgresChatDeliveryRepository } from './deliveryRepository.js'

export type DeliveryInputRead = NonNullable<z.infer<typeof ReadAgentChatRequestSchema>['deliveryInputs']>
export type RetainedDeliveryInput = NonNullable<z.infer<typeof ReadAgentChatResponseSchema>['deliveryInputs']>['items'][number]

function bodyChunk(command: StoredDelivery, cursor?: string, maxCharacters = 16 * 1024): Pick<RetainedDeliveryInput, 'content' | 'truncated' | 'bodyCursor'> {
  const bodyScope = { receiptId: command.receipt.id, target: command.request.target, inputHash: command.inputHash }
  const offset = decodeCursor(bodyScope, cursor) ?? 0
  if (offset > command.request.content.length) throw new DomainError('CHAT_BODY_CURSOR_INVALID', 'The input body cursor is outside its retained content.', 422)
  let end = Math.min(command.request.content.length, offset + maxCharacters)
  if (end < command.request.content.length && /[\uD800-\uDBFF]/.test(command.request.content[end - 1]!)) end--
  const truncated = end < command.request.content.length
  return { content: command.request.content.slice(offset, end), truncated,
    bodyCursor: truncated ? encodeCursor(bodyScope, end) : null }
}

/** C's outer-wrapper projection: never invents a native message or a conversation ID. */
export async function readRetainedDeliveryInputs(repository: Pick<PostgresChatDeliveryRepository, 'targetSnapshot' | 'byReceipt'>,
  target: DeliveryTarget, input: DeliveryInputRead = {}) {
  const limit = pageLimit(input.limit)
  if (input.bodyCursor && !input.receiptId) throw new DomainError('CHAT_BODY_RECEIPT_REQUIRED', 'A body continuation needs its exact receipt.', 422)
  const scope = { target, receiptId: input.receiptId ?? null }
  if (input.receiptId) {
    const exact = await repository.byReceipt(input.receiptId)
    if (!exact || commandInputHash(exact.request.target) !== commandInputHash(target)) {
      throw new DomainError('CHAT_INPUT_NOT_FOUND', 'No retained input belongs to that exact target and receipt.', 404)
    }
  }
  const { rows, revision } = await repository.targetSnapshot(target, decodeCursor(scope, input.cursor), limit + 1, input.receiptId)
  const items: RetainedDeliveryInput[] = []
  const page = (values: RetainedDeliveryInput[]) => {
    const hasMore = rows.length > values.length, last = rows[values.length - 1]
    return { items: [...values].reverse(), nextCursor: hasMore && last ? encodeCursor(scope, last.sequence) : null,
      hasMore, revision }
  }
  const fits = (values: RetainedDeliveryInput[]) => Buffer.byteLength(JSON.stringify(page(values))) <= CHANNEL_PAGE_BYTES
  for (const row of rows.slice(0, limit)) {
    const item = (characters = 16 * 1024): RetainedDeliveryInput => ({ commandId: row.request.commandId, receiptId: row.receipt.id,
      target: row.request.target, origin: row.request.sourcePostId ? 'group' : 'direct',
      ...(row.request.sourcePostId ? { sourcePostId: row.request.sourcePostId } : {}),
      ...bodyChunk(row, input.bodyCursor, characters), attachments: row.request.attachments ?? [],
      intent: row.request.intent, createdAt: row.receipt.createdAt })
    if (fits([...items, item()])) { items.push(item()); continue }
    if (items.length) break
    let low = 0, high = 16 * 1024
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits([item(middle)])) low = middle; else high = middle - 1
    }
    const bounded = item(low)
    if (!low || bounded.truncated && !bounded.content.length || !fits([bounded])) {
      throw new DomainError('CHAT_INPUT_METADATA_TOO_LARGE', 'Retained file metadata exceeds the bounded read window.', 413)
    }
    items.push(bounded)
  }
  return page(items)
}
