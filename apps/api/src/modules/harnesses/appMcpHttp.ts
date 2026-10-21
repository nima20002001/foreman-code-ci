import { WORKER_MCP_RESPONSE_MAX_BYTES } from '@foreman-code/contracts/worker-mcp-relay'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { DomainError } from '../errors.js'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** The API authenticates every forwarded request with its current scoped credential. */
export async function requestAppMcp(endpoint: string, body: unknown, token: string,
  protocolVersion?: string, signal?: AbortSignal, timeoutMs = deviceRequestTimeoutMs) {
  signal?.throwIfAborted()
  const requestBody = JSON.stringify(body)
  const deadline = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  const url = new URL(endpoint)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  // Node HTTP preserves the caller's budget without fetch's separate header deadline.
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = send(url, { method: 'POST', signal: requestSignal, headers: {
        authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json',
        ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
      } }, resolve)
      request.once('error', reject)
      request.end(requestBody)
    })
    return await readResponse(response)
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason
    throw error
  }
}

async function readResponse(response: IncomingMessage) {
  const statusCode = response.statusCode
  if (statusCode === undefined) throw new DomainError('WORKER_MCP_RESPONSE_INVALID', 'The MCP response has no HTTP status.', 502)
  if ([301, 302, 303, 307, 308].includes(statusCode)) {
    response.destroy()
    throw new TypeError('The selected MCP endpoint must not redirect a scoped request.')
  }
  const chunks: Uint8Array[] = []
  let byteLength = 0
  for await (const chunk of response) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > WORKER_MCP_RESPONSE_MAX_BYTES) {
      response.destroy()
      throw new DomainError('WORKER_MCP_RESPONSE_INVALID', 'The selected Main MCP response exceeds its relay limit.', 502)
    }
    chunks.push(bytes)
  }
  const payload = Buffer.concat(chunks).toString('utf8')
  const type = response.headers['content-type']
  let contentType: 'empty' | 'application/json' | 'text/event-stream' | undefined
  if (payload === '') contentType = 'empty'
  else if (type?.startsWith('application/json')) contentType = 'application/json'
  else if (type?.startsWith('text/event-stream')) contentType = 'text/event-stream'
  if (!contentType) throw new DomainError('WORKER_MCP_RESPONSE_INVALID', 'The selected main returned an unsupported MCP response.', 502)
  return { statusCode, contentType, body: payload }
}
