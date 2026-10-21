import { omitProperties } from '../../shared/omitProperties.js'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import {
  WorkflowChatPostRequestSchema, type WorkflowChatPostRequest, type WorkflowChatPost,
  type DeliveryTarget, type ChatDeliveryReceipt,
} from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { ChannelScope } from './model.js'

export const CHANNEL_PAGE_BYTES = 256 * 1024
export const CHANNEL_BODY_BYTES = 16 * 1024

export function channelCommand(raw: unknown, author: WorkflowChatPost['author']): WorkflowChatPostRequest & { commandId: string } {
  const request = WorkflowChatPostRequestSchema.parse(raw)
  if (!request.body.trim() || Buffer.byteLength(request.body, 'utf8') > CHANNEL_BODY_BYTES) {
    throw new DomainError('CHAT_POST_INVALID', 'A Group post needs text and may contain at most 16 KiB of UTF-8 text.', 422)
  }
  if (author.kind === 'agent' && (request.mentions.length || request.deliveries.length)) {
    throw new DomainError('CHAT_AGENT_MENTIONS_DENIED', 'Agent posts cannot wake another Agent. Post the reply without mentions.', 403)
  }
  if (author.kind === 'system') throw new DomainError('CHAT_ACTOR_INVALID', 'System posts come only from committed source facts.', 403)
  const mentions = [...request.mentions].sort((a, b) => a.start - b.start)
  let end = 0
  for (const mention of mentions) {
    if (mention.start < end || mention.end > request.body.length || mention.start >= mention.end
      || splitsSurrogate(request.body, mention.start) || splitsSurrogate(request.body, mention.end)) {
      throw new DomainError('CHAT_MENTION_INVALID', 'Mention spans must select complete, nonoverlapping text in the exact submitted body.', 422)
    }
    end = mention.end
  }
  const nodes = new Set(request.mentions.map(mention => mention.workflowNodeId))
  const recipients = new Set<string>()
  for (const delivery of request.deliveries) {
    if (recipients.has(delivery.workflowNodeId) || !nodes.has(delivery.workflowNodeId)
      || delivery.target.kind === 'operator_conversation'
      || delivery.target.agent.workflowNodeId !== delivery.workflowNodeId) {
      throw new DomainError('CHAT_RECIPIENT_INVALID', 'Each explicitly mentioned node needs exactly one Agent delivery.', 422)
    }
    assertTargetScope(delivery.target, request)
    recipients.add(delivery.workflowNodeId)
  }
  if (recipients.size !== nodes.size) throw new DomainError('CHAT_RECIPIENT_REQUIRED', 'Resolve every mentioned Agent before posting.', 422)
  return { ...request, commandId: request.commandId ?? randomUUID() }
}

function splitsSurrogate(text: string, at: number): boolean {
  return at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]!) && /[\uDC00-\uDFFF]/.test(text[at]!)
}

export function assertTargetScope(target: DeliveryTarget, scope: ChannelScope): void {
  if (target.kind === 'operator_conversation' || target.agent.workspaceId !== scope.workspaceId
    || target.agent.workflowId !== scope.workflowId) {
    throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'The selected target belongs to a different workflow.', 403)
  }
}

export function recipientCommandId(postCommandId: string, nodeId: string): string {
  return `group:${commandInputHash([postCommandId, nodeId]).slice(7)}`
}

export function receiptId(principalId: string, commandId: string): string {
  return `chat:${commandInputHash([principalId, commandId]).slice(7)}`
}

export function effectiveInput(request: { commandId?: string | undefined; [key: string]: unknown }): string {
  const input = omitProperties(request, ['commandId'])
  return commandInputHash(input)
}

export function isTerminalReceipt(receipt: ChatDeliveryReceipt): boolean {
  return ['completed', 'failed', 'canceled'].includes(receipt.state)
}

export function pageLimit(value = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new DomainError('CHAT_PAGE_INVALID', 'Use a page limit between 1 and 100.', 422)
  return value
}

export function encodeCursor(scope: unknown, sequence: number): string {
  return Buffer.from(JSON.stringify({ key: commandInputHash(scope), sequence })).toString('base64url')
}

export function decodeCursor(scope: unknown, cursor?: string): number | undefined {
  if (!cursor) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (typeof value !== 'object' || value === null || !('key' in value) || value.key !== commandInputHash(scope)
      || !('sequence' in value) || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error('scope')
    return value.sequence
  } catch (error) {
    throw new DomainError('CHAT_CURSOR_INVALID', 'This cursor does not belong to the selected chat and filter.', 422, undefined, { cause: error })
  }
}
