import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Tracks in-flight HTTP requests. Closing the API waits for every one of them, so a call that never answered held
 * each production stop until systemd killed the process. After `graceMs` of shutdown, the requests matched by
 * `closable` (MCP tool calls, which clients retry with their commandId) are ended; other requests still finish.
 */
export function trackInFlightRequests(app: FastifyInstance,
  options: { graceMs: number; closable: (url: string) => boolean }) {
  const inFlight = new Map<string, { request: FastifyRequest; label: string; readOnlyWait: boolean }>()
  app.addHook('onRequest', async request => {
    inFlight.set(request.id, { request, label: `${request.method} ${request.url.split('?')[0]}`, readOnlyWait: false })
  })
  app.addHook('preHandler', async request => {
    const entry = inFlight.get(request.id)
    const body = request.body as { method?: unknown; params?: { name?: unknown } } | null | undefined
    const tool = body?.params?.name
    if (entry && typeof tool === 'string') {
      entry.label += ` ${tool.slice(0, 80)}`
      entry.readOnlyWait = body?.method === 'tools/call' && tool === 'ci_get'
    }
  })
  const done = async (request: FastifyRequest) => { inFlight.delete(request.id) }
  app.addHook('onResponse', done)
  app.addHook('onRequestAbort', done)
  let grace: NodeJS.Timeout | undefined
  app.addHook('preClose', async () => {
    // CI status waits are read-only and retry after restart; mutations retain their shutdown grace.
    for (const { request, readOnlyWait } of inFlight.values()) {
      if (readOnlyWait && options.closable(request.url)) request.raw.socket?.destroy()
    }
    grace ??= setTimeout(() => {
      for (const { request } of inFlight.values()) {
        if (options.closable(request.url)) request.raw.socket?.destroy()
      }
    }, options.graceMs)
    grace.unref()
  })
  app.addHook('onClose', async () => { if (grace) clearTimeout(grace) })
  return { describe: () => [...inFlight.values()].map(entry => entry.label), size: () => inFlight.size }
}
