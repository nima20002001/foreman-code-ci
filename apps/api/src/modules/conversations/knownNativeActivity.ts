import { asRecord } from '../../shared/records.js'
import type { ActivityNativeIdentity, NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import { operatorActivity, type OperatorActivityChange } from './operatorActivity.js'

/** Late item settlement never relaxes the owning adapter's root terminal guard. No root/message terminal is returned. */
export function knownNativeActivity(event: NativeHarnessEvent, harness: NativeSessionReference['harness']):
  { change: Omit<OperatorActivityChange, 'requestId'>; native: ActivityNativeIdentity } | undefined {
  // App request errors do not settle a previously observed native tool item.
  if (event.type === 'interaction.unsupported') return undefined
  let normalized = event
  if (event.type === 'native.unlinked_notification') {
    if (event.payload.method !== 'item/completed') return undefined
    normalized = { ...event, type: 'item.completed', payload: asRecord(event.payload.params) }
  }
  const change = operatorActivity(normalized, harness, 'known-native-source')
  if (!change || change.kind === 'thinking' || !['completed', 'failed', 'canceled'].includes(change.status)) return undefined
  const part = asRecord(normalized.payload.part)
  const sessionId = normalized.payload.threadId ?? normalized.payload.nativeSessionId ?? part.sessionID
  const turnId = normalized.payload.turnId ?? normalized.payload.nativeTurnId
  if (typeof sessionId !== 'string' || !sessionId || typeof turnId !== 'string' || !turnId) return undefined
  const generation = event.payload.nativeGeneration ?? event.payload.runtimeGeneration
  const { requestId: _, ...facts } = change
  void _
  return { change: facts, native: { harness, sessionId, turnId, itemId: change.id,
    ...(typeof generation === 'string' ? { generation } : typeof generation === 'number' && Number.isSafeInteger(generation)
      ? { generation: String(generation) } : {}) } }
}
