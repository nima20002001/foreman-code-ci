import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { ActivityTextIdentity, ActivityTextOperation } from '@foreman-code/contracts/activity-text'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import { normalizeNativeTextOperations } from './nativeTextStream.js'
import { nativeActivityFence } from './nativeActivityFence.js'
import type { NativeMessageSubmission } from '../harnesses/port.js'
import type { NativeSessionReference } from '@foreman-code/contracts'

/** Canonical message writes precede presentation coalescing; each source operation keeps its provenance. */
export function committedNativeText(input: {
  id: string; requestId: string; repository: PostgresOperatorConversationRepository;
  harness: 'codex' | 'claude'; session: NativeSessionReference;
  owner(): Omit<ActivityTextIdentity, 'itemId' | 'partId' | 'parentId' | 'channel'>;
  reconcile(): void;
  sanitize?(operation: ActivityTextOperation): ActivityTextOperation;
}) {
  const parents = new Map<string, string>()
  let revision: string | undefined
  return {
    revision: () => revision,
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
        if (result?.status === 'committed') { revision = result.revision; final ||= operation.final }
        else {
          allowed = false
          if (result?.status === 'reconciliation_required') input.reconcile()
        }
      }
      return { allowed, handled: true, final }
    },
  }
}
