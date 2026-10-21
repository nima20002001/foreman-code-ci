import { WorkflowHierarchyChangeSchema } from '@foreman-code/contracts'

/** Consume the real authenticated SSE route; heartbeats are not changes. */
export async function openHierarchyEvents(address: string, path: string, token: string) {
  const abort = new AbortController()
  const response = await fetch(new URL(path, address), {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal: abort.signal,
  })
  if (!response.ok || !response.body) throw new Error(`Hierarchy stream failed: ${response.status}`)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffered = ''
  return {
    async next() {
      const timeout = setTimeout(() => abort.abort(new Error('Timed out waiting for a committed hierarchy change')), 15_000)
      try {
        for (;;) {
          const end = buffered.indexOf('\n\n')
          if (end !== -1) {
            const event = buffered.slice(0, end); buffered = buffered.slice(end + 2)
            if (!event.includes('event: changed')) continue
            const data = event.split('\n').find(line => line.startsWith('data: '))
            if (!data) throw new Error('Changed event has no data')
            const change = WorkflowHierarchyChangeSchema.parse(JSON.parse(data.slice(6)))
            if (!event.includes(`id: ${change.cursor}\n`)) throw new Error('SSE ID differs from its committed cursor')
            return change
          }
          const chunk = await reader.read()
          if (chunk.done) throw new Error('Hierarchy stream closed before the next change')
          buffered += decoder.decode(chunk.value, { stream: true })
        }
      } finally { clearTimeout(timeout) }
    },
    async close() {
      abort.abort()
      await reader.cancel().catch(() => { /* ignore: aborting the fetch can already have errored the stream being canceled. */ })
    },
  }
}
