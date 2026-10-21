import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { createSseWriter } from '../../routes/sseWriter.js'
import type { MemoryBoardService } from './service.js'

export async function streamMemoryBoard(request: FastifyRequest, reply: FastifyReply, service: Pick<MemoryBoardService,'changes'|'listen'>,
  principal: ManagementPrincipal, boardId: string, afterSequence?: number): Promise<void> {
  let stopped=false, running=false, dirty=false, opened=false, cursor=afterSequence
  let unsubscribe: (()=>void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (stopped) return
    stopped=true;unsubscribe?.();writer.close();clearInterval(heartbeat)
    if(opened && !reply.raw.destroyed)reply.raw.end()
  }
  const writer=createSseWriter(reply.raw,()=>!stopped,stop,{frameBytes:131072,queuedBytes:262144,queuedFrames:128,drainTimeoutMs:15000})
  reply.raw.once('close',stop)
  request.raw.once('aborted',stop)
  if(reply.raw.destroyed || request.raw.aborted)stop()
  const pump = async () => {
    if (running || stopped) { dirty=true;return }
    running=true
    try {
      do {
        dirty=false
        const currentPrincipal=request.reauthorizeOperator ? await request.reauthorizeOperator() : principal
        const page=await service.changes(currentPrincipal,{boardId,afterSequence:cursor,limit:100})
        if (page.resetRequired) {
          writer.write(`event: reset\ndata: ${JSON.stringify({watermark:page.watermark})}\n\n`)
          cursor=page.watermark
        } else {
          for (const change of page.items) {
            writer.write(`event: change\nid: ${change.sequence}\ndata: ${JSON.stringify(change)}\n\n`)
            cursor=change.sequence
          }
          if (!page.hasMore) cursor=page.watermark
          dirty ||= page.hasMore
        }
      } while (dirty && !stopped)
    } catch (error) {
      request.log.warn({err:error,boardId},'Memory board stream closed during authorized readback')
      stop()
    } finally { running=false }
  }
  try {
    // Authenticate before allocating a listener, while already observing close.
    const initial = await service.changes(principal,{boardId,limit:1})
    cursor ??= initial.watermark
    if(stopped)return
    unsubscribe=await service.listen(boardId,()=>{dirty=true;if(opened)void pump()},stop)
    if (stopped) { unsubscribe();return }
    reply.hijack()
    reply.raw.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'})
    opened=true
    heartbeat=setInterval(()=>writer.write(': keepalive\n\n'),15000)
    heartbeat.unref()
    writer.write(': connected\n\n')
    await pump()
  } catch (error) { stop();throw error }
}
