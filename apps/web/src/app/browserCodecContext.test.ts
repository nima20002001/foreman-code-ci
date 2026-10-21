import { expect, it } from 'vitest'
import { createBrowserHttp, type BrowserWireCodec } from '../features/agent-browser/http'

it('keeps each concurrent browser response bound to its original selection', async () => {
  const call = createBrowserHttp({ fetch: async () => new Response('{}', { status: 200 }),
    error: async () => ({ message: 'Unexpected HTTP failure' }) })
  const codec: BrowserWireCodec<[string], string> = {
    encode: selection => ({ json: { selection } }),
    decode: async (_response, args?: [string]) => args?.[0] ?? 'missing call context',
  }
  expect(await Promise.all([
    call('POST', '/api/browser/selection', codec, ['first']),
    call('POST', '/api/browser/selection', codec, ['second']),
  ])).toEqual(['first', 'second'])
})

it('sends browser file bytes with the canonical binary content type', async () => {
  const requests: Request[] = []
  const call = createBrowserHttp({ fetch: async (input, init) => { requests.push(new Request(input, init)); return new Response('{}') },
    error: async () => ({ message: 'Unexpected HTTP failure' }) })
  await call('PUT', '/api/browser/bytes', { encode: () => ({ bytes: Uint8Array.of(1, 2) }), decode: async () => undefined }, [])
  expect(requests[0]!.headers.get('content-type')).toBe('application/octet-stream')
  expect(new Uint8Array(await requests[0]!.arrayBuffer())).toEqual(Uint8Array.of(1, 2))
})
