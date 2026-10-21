import type { FastifyReply, FastifyRequest } from 'fastify'

export async function pluginHttpRead<T>(request: FastifyRequest, reply: FastifyReply, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Plugin HTTP read was canceled.'))
  const closed = () => { if (!reply.raw.writableEnded) abort() }
  request.raw.once('aborted', abort)
  reply.raw.once('close', closed)
  if (request.raw.aborted || reply.raw.destroyed) abort()
  try { return await read(controller.signal) }
  finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', closed) }
}
