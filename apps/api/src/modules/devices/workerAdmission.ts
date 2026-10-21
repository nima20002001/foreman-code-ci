import { REMOTE_PREPARATION_EXTENSION } from '@foreman-code/contracts/remote-execution-rpc'
import { SOURCE_OPERATION_EXTENSION } from '@foreman-code/contracts/source-operations'
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance'
import { CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE } from '@foreman-code/contracts'

export function isWorkerAdmission(namespace: string, payload: unknown): boolean {
  if (namespace === 'managed-mcp-v1' && payload && typeof payload === 'object' && 'request' in payload) {
    const request = payload.request
    if (request && typeof request === 'object' && 'operation' in request) return request.operation === 'apply'
  }
  if (namespace === 'harness-discovery-v1' || namespace === 'host-harness-check-v1') return true
  if (!payload || typeof payload !== 'object') return false
  if (namespace === REMOTE_PREPARATION_EXTENSION.namespace && 'method' in payload) {
    return payload.method === 'prepare'
  }
  if (namespace === 'execution-v1' && 'method' in payload) {
    if (payload.method === 'conversation.file-copy' && 'copy' in payload && payload.copy
      && typeof payload.copy === 'object' && 'phase' in payload.copy && payload.copy.phase === 'close') return false
    return ['job-dispatch', 'prepare', 'prepare-review', 'start-turn', 'session-compact', 'capabilities', 'inspect-mcp',
      'conversation.open', 'conversation.initial-turn', 'conversation.start-turn', 'conversation.compact',
      'conversation.capabilities', 'conversation.inspect-mcp', 'conversation.inspect-entry',
      'conversation.file-copy']
      .includes(String(payload.method))
  }
  if (namespace === 'byte-transfer-v1' && 'method' in payload) return payload.method === 'start'
  if (namespace === 'rsync-stage-v1' && 'method' in payload) {
    return ['source-prepare', 'receiver-prepare', 'writer-prepare', 'writer-activate'].includes(String(payload.method))
  }
  if (!('operation' in payload)) return false
  return namespace === SOURCE_OPERATION_EXTENSION.namespace && payload.operation === 'sources.prepare'
    || namespace === COMPUTER_MAINTENANCE_NAMESPACE && payload.operation === 'start'
    || namespace === 'job-runtime-qualification-v1' && ['start', 'run'].includes(String(payload.operation))
    || namespace === CI_RUNTIME_NAMESPACE && payload.operation === 'prepare'
    || namespace === CI_HOST_NAMESPACE && payload.operation === 'start'
}

/** Discovery and maintenance must remain available to converge a stale Worker. */
export function requiresWorkerBundle(namespace: string, payload: unknown): boolean {
  if ([COMPUTER_MAINTENANCE_NAMESPACE, 'harness-discovery-v1', 'host-harness-check-v1', 'managed-mcp-v1']
    .includes(namespace)) return false
  return isWorkerAdmission(namespace, payload)
}
