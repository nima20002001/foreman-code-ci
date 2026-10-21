import type { NativeHarnessEvent, Message } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { ActivityTextIdentity, ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { normalizeNativeTextOperations } from './nativeTextStream.js'
import { nativeActivityFence } from './nativeActivityFence.js'
import type { NativeMessageSubmission } from '../harnesses/port.js'
import type { NativeSessionReference } from '@foreman-code/contracts'

/** Canonical message writes precede presentation coalescing; each source operation keeps its provenance. */
export function committedNativeText(input: {
  id: string; requestId: string; repository: Pick<PostgresOperatorConversationRepository, 'appendAssistantTextOperation'>;
  harness: 'codex' | 'claude'; session: NativeSessionReference;
  owner(): Omit<ActivityTextIdentity, 'itemId' | 'partId' | 'parentId' | 'channel'>;
  reconcile(): void;
  sanitize?(operation: ActivityTextOperation): ActivityTextOperation;
}) {
  const parents = new Map<string, string>()
  const messages = new Map<string, Message>()
  let revision: string | undefined
  return {
    revision: () => revision,
    /** Exact committed replacement, with the original durable/native IDs. No inferred append offset. */
    message: (operation: ActivityTextOperation) => messages.get(canonicalJson(operation.identity)),
    async record(event: NativeHarnessEvent, nativeTurnId: string | null, nativeSubmission?: NativeMessageSubmission): Promise<{ allowed: boolean; handled: boolean; final: boolean }> {
      const normalized = normalizeNativeTextOperations(event, { harness: input.harness, owner: input.owner, parents })
      const publicText = normalized.filter((operation): operation is ActivityTextOperation => !!operation && operation.identity.channel === 'assistant')
      if (!publicText.length) return { allowed: true, handled: false, final: false }
      if (!nativeTurnId && !nativeSubmission) { input.reconcile(); return { allowed: false, handled: true, final: false } }
      let allowed = true, final = false
      for (const raw of publicText) {
        const operation = input.sanitize ? input.sanitize(raw) : raw
        const result = await input.repository.appendAssistantTextOperation(input.id, input.requestId, operation,
          nativeActivityFence(input.session, nativeTurnId, event, false, nativeSubmission))
        if (result?.status === 'committed') {
          revision = result.revision; final ||= operation.final
          if (result.message) {
            const key = canonicalJson(operation.identity)
            messages.delete(key); messages.set(key, boundedMessage(result.message))
            while (messages.size > 8) messages.delete(messages.keys().next().value!)
          }
        }
        else {
          allowed = false
          if (result?.status === 'reconciliation_required') input.reconcile()
        }
      }
      return { allowed, handled: true, final }
    },
  }
}

function boundedMessage(message: Message): Message {
  const bytes = Buffer.byteLength(message.content)
  if (bytes <= 24 * 1024) return message
  let end = Math.min(message.content.length, 24 * 1024)
  while (Buffer.byteLength(message.content.slice(0, end)) > 24 * 1024) end = Math.floor(end * 0.8)
  if (/[\uD800-\uDBFF]/.test(message.content[end - 1] ?? '')) end--
  return { ...message, content: message.content.slice(0, end), truncation: { truncated: true,
    originalBytes: Math.max(bytes, message.truncation?.originalBytes ?? 0) } }
}
