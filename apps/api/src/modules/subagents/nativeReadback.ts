import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

const CursorSchema = z.object({ root: z.string().min(1), target: z.string().min(1), cursor: z.string().nullable(), offset: z.number().int().nonnegative().optional(), children: z.array(z.string().min(1).max(512)).max(128).optional() }).strict()
export type NativeChildCursor = z.infer<typeof CursorSchema>
export function childHistoryCursor(root: string, value?: string): NativeChildCursor {
  if (!value) return { root, target: root, cursor: null }
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()))
    if (parsed.root === root) return parsed
  } catch { /* ignore: opaque cursor never grants a native address outside the original parent. */ }
  throw new DomainError('SUBAGENT_NATIVE_CURSOR_INVALID', 'Native child history cursor does not match its original parent.', 409)
}
export function encodeChildHistoryCursor(cursor: NativeChildCursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url') }
/** Stable native readback identity; ingestion reuses the first durable observation timestamp on exact replay. */
export function childHistoryEvent(type: string, payload: Record<string, unknown>, occurredAt = new Date().toISOString()): NativeHarnessEvent {
  const digest = createHash('sha256').update(JSON.stringify([type, payload])).digest('hex')
  return { type, payload, occurredAt, connectionId: `child-history-${digest}`, sequence: 0 }
}
