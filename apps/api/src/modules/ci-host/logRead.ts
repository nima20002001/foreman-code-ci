import { CI_LOG_MAX_BYTES } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import { sanitizeCiText } from './text.js'

export async function readHostCiLog(endpoint: HostCiEndpoint, computer: HostCiComputer, runId: string,
  input: { afterOffset?: number | undefined; maxBytes?: number | undefined }) {
  const maxBytes = input.maxBytes ?? CI_LOG_MAX_BYTES
  if (maxBytes === 0) {
    const state = await endpoint.request(computer, { operation: 'read', runId, afterOffset: 0, maxBytes: 0 })
    if (state.operation !== 'read') {
      throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
    }
    return { text: '', nextOffset: input.afterOffset ?? state.run.logBytes, logBytes: state.run.logBytes, maxBytes }
  }
  let afterOffset = input.afterOffset
  if (afterOffset === undefined) {
    const state = await endpoint.request(computer, { operation: 'read', runId, afterOffset: 0, maxBytes: 0 })
    afterOffset = state.operation === 'read' ? Math.max(0, state.run.logBytes - maxBytes) : 0
  }
  const reply = await endpoint.request(computer, { operation: 'read', runId, afterOffset, maxBytes })
  if (reply.operation !== 'read') {
    throw new DomainError('CI_HOST_REPLY_INVALID', 'The build computer replied out of order.', 502)
  }
  return { text: sanitizeCiText(reply.text), nextOffset: reply.nextOffset, logBytes: reply.run.logBytes, maxBytes }
}
