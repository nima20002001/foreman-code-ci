import { DomainError } from '../../modules/errors.js'

type RequestId = string | number

/** HTTP transports are stateless; cancellation follows the authenticated caller and RPC id. */
export class McpRequestCancellation {
  private readonly callers = new Map<string, Map<RequestId, AbortController>>()

  track(principalId: string, requestId: RequestId) {
    const requests = this.callers.get(principalId) ?? new Map<RequestId, AbortController>()
    if (requests.has(requestId)) {
      throw new DomainError('MCP_REQUEST_IN_FLIGHT', 'This MCP request id is already in flight.', 409)
    }
    const controller = new AbortController()
    requests.set(requestId, controller)
    this.callers.set(principalId, requests)
    let finished = false
    return {
      signal: controller.signal,
      cancel: () => controller.abort(),
      finish: () => {
        if (finished) return
        finished = true
        requests.delete(requestId)
        if (!requests.size) this.callers.delete(principalId)
      },
    }
  }

  cancel(principalId: string, requestId: RequestId): void {
    this.callers.get(principalId)?.get(requestId)?.abort()
  }
}
