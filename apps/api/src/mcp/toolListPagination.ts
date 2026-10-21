import { createHash } from 'node:crypto'
import { McpServer, ProtocolError, ProtocolErrorCode, type ListToolsRequest,
  type ListToolsResult, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'

const pageBytes = 400 * 1024
const Cursor = z.object({ catalog: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().positive() }).strict()
type ListHandler = (request: ListToolsRequest, context: ServerContext) => ListToolsResult | Promise<ListToolsResult>

function page(result: ListToolsResult, request: ListToolsRequest): ListToolsResult {
  const catalog = createHash('sha256').update(JSON.stringify(result.tools)).digest('hex')
  let offset = 0
  if (request.params?.cursor !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.from(request.params.cursor, 'base64url').toString('utf8')) }
    catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid tool catalog cursor.') }
    const cursor = Cursor.safeParse(parsed)
    if (!cursor.success || cursor.data.catalog !== catalog || cursor.data.offset >= result.tools.length) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool catalog changed or its cursor is invalid. List from the start.')
    }
    offset = cursor.data.offset
  }
  const tools: ListToolsResult['tools'] = []
  let bytes = Buffer.byteLength(JSON.stringify({ ...result, tools: [], nextCursor: 'x'.repeat(256) }))
  while (offset < result.tools.length) {
    const tool = result.tools[offset]!
    const size = Buffer.byteLength(JSON.stringify(tool)) + 1
    if (bytes + size > pageBytes) {
      if (!tools.length) throw new ProtocolError(ProtocolErrorCode.InternalError, 'A tool schema exceeds the catalog page budget.')
      break
    }
    tools.push(tool)
    bytes += size
    offset++
  }
  const nextCursor = offset < result.tools.length
    ? Buffer.from(JSON.stringify({ catalog, offset })).toString('base64url') : undefined
  return { ...result, tools, ...(nextCursor ? { nextCursor } : {}) }
}

/** Retains the SDK's schema conversion and grant-filtered definitions. */
export function paginateToolLists(server: McpServer): void {
  const protocol = server.server
  protocol.setRequestHandler = new Proxy(protocol.setRequestHandler, {
    apply(register, target, arguments_) {
      if (arguments_[0] === 'tools/list') {
        const list = arguments_[1] as ListHandler
        const handler: ListHandler = async (request, context) => page(await list(request, context), request)
        return Reflect.apply(register, target, ['tools/list', handler])
      }
      return Reflect.apply(register, target, arguments_)
    },
  })
}
