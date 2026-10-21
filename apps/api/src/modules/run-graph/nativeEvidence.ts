import { canonicalGraphJson, NATIVE_GRAPH_EVIDENCE_MAX_BYTES } from '@foreman-code/contracts/wave25'
import { nativeObject } from '../runs/nativeAction.js'

const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const object = nativeObject(value)
  return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]))
}
export type SafeNativeEvidence = { kind: 'evidence'; type: string; payload: Record<string, unknown> }
  | { kind: 'ignored' } | { kind: 'invalid'; code: 'GRAPH_EVIDENCE_INVALID' | 'GRAPH_EVIDENCE_TOO_LARGE' }

/** Do not serialize or walk routine token/output/metadata payloads in the graph hot path. */
export function selectNativeGraphEvidence(type: string, input: Record<string, unknown>): SafeNativeEvidence {
  if (type === 'turn.completed' && input.willRetry === true && input.status === 'failed') return { kind: 'ignored' }
  if (!['item.started', 'item.completed', 'item.snapshot', 'turn.started', 'turn.completed', 'message.updated', 'message.part.updated'].includes(type)) return { kind: 'ignored' }
  const payload = pick(input, ['threadId', 'turnId', 'sessionID', 'nativeTurnStatus'])
  if (type.startsWith('item.')) {
    const item = pick(input.item, ['id', 'type', 'status', 'server', 'tool'])
    const original = nativeObject(input.item)
    // Only a boolean is necessary to recognize a failed tool; never retain an error body.
    if (original.error) item.error = true
    if (Array.isArray(original.commandActions)) {
      if (original.commandActions.length > 128) return { kind: 'invalid', code: 'GRAPH_EVIDENCE_TOO_LARGE' }
      item.commandActions = original.commandActions.map((action) => pick(action, ['type']))
    }
    payload.item = item
  } else if (type.startsWith('turn.')) {
    const turn = pick(input.turn, ['id', 'status'])
    if (turn.id === undefined && typeof input.turnId === 'string') turn.id = input.turnId
    if (type === 'turn.started') turn.status = 'inProgress'
    else if (turn.status === undefined && typeof input.status === 'string') turn.status = input.status
    payload.turn = turn
  }
  else if (type === 'message.updated') payload.info = pick(input.info, ['id', 'parentID', 'sessionID', 'role', 'summary'])
  else {
    payload.part = { ...pick(input.part, ['id', 'messageID', 'sessionID', 'type', 'tool']), state: pick(nativeObject(input.part).state, ['status']) }
  }
  try { canonicalGraphJson(payload, NATIVE_GRAPH_EVIDENCE_MAX_BYTES) } catch (error) {
    return { kind: 'invalid', code: error instanceof Error && error.message === 'GRAPH_JSON_LIMIT' ? 'GRAPH_EVIDENCE_TOO_LARGE' : 'GRAPH_EVIDENCE_INVALID' }
  }
  return { kind: 'evidence', type, payload }
}
