import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { MAX_FILE_WRITE_BYTES } from '@foreman-code/contracts/files'
import { createFileMcpServer, type FileMcpService } from '../../files/tools/mcpServer.js'
import { DomainError } from '../../errors.js'

/** Temporary native qualification tools use the same file MCP server as the app. */
export async function createQualificationFileMcpListener(service: FileMcpService, token: string, options: {
  observeRequest?: (request: { method: string; body: unknown }) => (statusCode: number) => void
} = {}) {
  const credential = createHash('sha256').update(`Bearer ${token}`).digest()
  const active = new Set<Promise<void>>()
  const failures: unknown[] = []
  let closing = false
  let shutdown: Promise<void> | undefined
  const listener = createServer((request, response) => {
    const task = (async () => {
      const authorized = timingSafeEqual(credential,
        createHash('sha256').update(request.headers.authorization ?? '').digest())
      response.setHeader('cache-control', 'no-store')
      if (closing || !authorized) {
        response.writeHead(401)
        response.end()
        return
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`)
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || request.headers.origin && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.headers.origin).hostname)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'POST' || url.pathname !== '/mcp/files') {
        response.writeHead(405)
        response.end()
        return
      }
      const chunks: Buffer[] = []
      let byteSize = 0
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        byteSize += bytes.length
        if (byteSize > 4 * Math.ceil(MAX_FILE_WRITE_BYTES / 3) + 512 * 1024) {
          response.writeHead(413)
          response.end()
          return
        }
        chunks.push(bytes)
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400)
        response.end()
        return
      }
      const completeObservation = options.observeRequest?.({ method: request.method, body })
      if (completeObservation) response.once('close', () => completeObservation(response.statusCode))
      const server = await createFileMcpServer(service, token)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const completed = new Promise<void>(resolve => { response.once('close', resolve) })
      try {
        await server.connect(transport)
        await transport.handleRequest(request, response, body)
        await completed
      } finally {
        const results = await Promise.allSettled([transport.close(), server.close()])
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) failures.push(...errors)
      }
    })().catch(error => {
      if (!response.headersSent) response.writeHead(error instanceof DomainError ? error.status : 500)
      response.end()
    })
    active.add(task)
    void task.then(() => active.delete(task))
  })
  listener.requestTimeout = 30_000
  listener.headersTimeout = 10_000
  listener.keepAliveTimeout = 1000
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => {
      listener.removeListener('error', reject)
      resolve()
    })
  })
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('The qualification file MCP listener has no address.')
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp/files`,
    close: () => shutdown ??= (async () => {
      closing = true
      await new Promise<void>((resolve, reject) => {
        listener.close(error => error ? reject(error) : resolve())
        listener.closeAllConnections()
      })
      await Promise.all([...active])
      if (failures.length) throw new AggregateError(failures, 'Qualification file MCP cleanup is unconfirmed.')
    })(),
  }
}
