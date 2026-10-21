import { createServer } from 'node:http'
import { finished } from 'node:stream/promises'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { MAX_FILE_WRITE_BYTES } from '@foreman-code/contracts/files'
import { createFileMcpServer, type FileMcpService } from './mcpServer.js'
import { DomainError } from '../../errors.js'

/** File-only loopback listener shared by native execution and qualification. */
export function createNativeFileMcpServer(service: () => FileMcpService, observe: (
  request: { method: string; body: unknown }, statusCode: number) => void) {
  const tasks = new Set<Promise<void>>()
  const server = createServer((request, response) => {
    const task = (async () => {
      response.setHeader('cache-control', 'no-store')
      if (request.method !== 'POST' || request.url !== '/mcp/files') {
        response.writeHead(405).end()
        return
      }
      const token = /^Bearer (gql_file_[A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '')?.[1]
      let selected: FileMcpService
      try {
        selected = service()
        await (selected.sessions.discover ?? selected.sessions.authenticate).call(selected.sessions, token)
      } catch {
        response.writeHead(401).end()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const value = Buffer.from(chunk)
        bytes += value.length
        if (bytes > 4 * Math.ceil(MAX_FILE_WRITE_BYTES / 3) + 512 * 1024) {
          response.writeHead(413).end()
          return
        }
        chunks.push(value)
      }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { response.writeHead(400).end(); return }
      response.once('finish', () => observe({ method: request.method!, body }, response.statusCode))
      const mcp = await createFileMcpServer(selected, token!)
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const delivered = finished(response, { readable: false })
      void delivered.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
      try {
        await mcp.connect(transport)
        await transport.handleRequest(request, response, body)
        await delivered
      } finally {
        await transport.close()
        await mcp.close()
      }
    })().catch(error => {
      if (!response.headersSent) response.writeHead(error instanceof DomainError ? error.status : 500).end()
      else response.destroy(error instanceof Error ? error : new Error('Native file MCP request failed', { cause: error }))
    })
    tasks.add(task)
    void task.then(() => tasks.delete(task), () => tasks.delete(task))
  })
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('File MCP qualification address unavailable')
      return `http://127.0.0.1:${address.port}`
    },
    async close() {
      if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
      await Promise.all([...tasks])
    },
  }
}
