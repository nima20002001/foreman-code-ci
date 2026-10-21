import type { RunGraphErrorCode } from '@foreman-code/contracts/wave25'

/** Never forward database errors, native bodies, paths or caller-supplied messages. */
export class RunGraphError extends Error {
  readonly code: RunGraphErrorCode
  constructor(code: RunGraphErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'RunGraphError'
    this.code = code
  }
}
export function runGraphErrorResponse(error: RunGraphError) {
  return { error: { code: error.code, message: 'The graph request could not be completed safely.' } }
}
export function runGraphErrorStatus(code: RunGraphErrorCode): number {
  if (['GRAPH_READ_ACCESS_DENIED', 'GRAPH_EFFECT_ACCESS_DENIED', 'GRAPH_SECURITY_UNQUALIFIED'].includes(code)) return 403
  if (code === 'GRAPH_NOT_INITIALIZED') return 404
  if (code === 'GRAPH_INVALID_CURSOR' || code === 'GRAPH_UNSUPPORTED_PROTOCOL' || code === 'GRAPH_INVALID_FACT' || code === 'GRAPH_EVIDENCE_INVALID' || code === 'GRAPH_AUTHORITY_INVALID') return 400
  if (code === 'GRAPH_SNAPSHOT_TOO_LARGE' || code === 'GRAPH_TRANSACTION_LIMIT' || code === 'GRAPH_EVIDENCE_TOO_LARGE') return 413
  return 409
}
