import type { NativeResponseAvailability, NativeResponseAvailabilityQuery } from '../responseAvailability.js'

/** Optional fields mirror the common inspector seam; supplied expectations must match resident evidence. */
export type ClaudeResponseAvailabilityQuery = NativeResponseAvailabilityQuery
export interface ClaudeResponseAvailability extends NativeResponseAvailability {
  nativeMessageId?: string
}
/** Lookup in the actual SDK callback map, not a database interaction/pending-row lookup. */
export interface ClaudeLiveCallbackQuery extends ClaudeResponseAvailabilityQuery {
  nativeSessionId: string
  nativeMessageId: string
  generation: string
}
export interface ClaudeLiveCallbackReader {
  inspectCallbackAvailability(query: ClaudeLiveCallbackQuery): ClaudeResponseAvailability | Promise<ClaudeResponseAvailability>
}
export interface ClaudeNativeCallbackContext {
  nativeSessionId: string
  nativeMessageId: string
  clientCorrelationId: string
  /** Opaque process-local callback lifetime identity; not a native message/turn ID. */
  generation: string
}

/** Captured from the accepted application message before offer; never inferred from latest actor state. */
export interface ClaudeCallbackAuthority {
  ownerPrincipalId: string
  attemptId: string
}
export interface ClaudePendingNotification {
  nativeSessionId: string
  nativeMessageId: string
  clientCorrelationId: string
  generation: string
  nativeRequestId: string
  nativeRequestType: 'can_use_tool'
}
