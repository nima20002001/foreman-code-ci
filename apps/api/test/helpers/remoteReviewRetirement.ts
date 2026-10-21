import type { DeviceApplicationFrame } from '@foreman-code/contracts/device-application'
import { RemoteWorkflowPhysicalAckSchema } from '@foreman-code/contracts/remote-workflow-physical'
import type { RawData } from 'ws'

/** Hold the real retirement reply so Main can crash after Worker persistence. */
export function retirementReplyBarrier(pauseReconnect: () => void) {
  const messages = new Map<string, { size: number; chunks: Buffer[]; received: number }>()
  let heldId: string | undefined
  let resolve: ((reply: ReturnType<typeof RemoteWorkflowPhysicalAckSchema.parse>) => void) | undefined
  return {
    arm() {
      if (resolve || heldId) throw new Error('A retirement reply is already held.')
      return new Promise<ReturnType<typeof RemoteWorkflowPhysicalAckSchema.parse>>(done => { resolve = done })
    },
    observe(data: RawData, direction: 'to-worker' | 'to-main') {
      const frame = JSON.parse(data.toString()) as DeviceApplicationFrame
      if (!('id' in frame)) return false
      // The response header must reach Main so its offset-zero ACK lets the
      // Worker send the body. Holding only that body leaves Main awaiting it.
      const held = direction === 'to-main' && frame.id === heldId && frame.type === 'application-chunk'
      const key = `${direction}:${frame.id}`
      if (frame.type === 'application-open' && frame.namespace === 'execution-v1') {
        messages.set(key, { size: frame.jsonBytes, chunks: [], received: 0 })
      }
      const message = messages.get(key)
      if (frame.type !== 'application-chunk' || !message) return held
      const bytes = Buffer.from(frame.data, 'base64')
      message.chunks.push(bytes)
      message.received += bytes.length
      if (message.received !== message.size) return held
      messages.delete(key)
      const payload = JSON.parse(Buffer.concat(message.chunks).toString('utf8')) as {
        method?: string; retire?: boolean
      }
      if (direction === 'to-worker' && resolve && payload.method === 'physical-ack' && payload.retire) {
        heldId = frame.id
      }
      if (held && resolve) {
        const reply = RemoteWorkflowPhysicalAckSchema.parse(payload)
        pauseReconnect()
        resolve(reply)
        resolve = undefined
      }
      return held
    },
  }
}
