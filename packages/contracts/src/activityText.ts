import { z } from 'zod'
import type { ActivityScope } from './activity.js'

export const TextTruncationSchema = z.object({ truncated: z.boolean(), originalBytes: z.number().int().nonnegative() }).strict()
export type TextTruncation = z.infer<typeof TextTruncationSchema>

/** Presentation text identity. The caller supplies the admitted owner, never a provider-derived owner. */
export interface ActivityTextIdentity {
  scope: ActivityScope
  requestId?: string
  attemptKey?: string
  generation?: string
  sessionId: string
  turnId?: string
  itemId: string
  partId?: string
  parentId?: string
  channel: 'assistant' | 'user' | 'reasoning'
}
export interface ActivityTextOperation {
  observedAt?: string
  identity: ActivityTextIdentity
  mode: 'append' | 'replace'
  text: string
  final: boolean
  truncation?: TextTruncation
  /** Observed transport ordering only. This is neither a durable revision nor a replay cursor. */
  source?: { connectionId?: string; sequence?: number; eventId?: string; nativeSequence?: string }
}
