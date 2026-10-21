import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { it } from 'vitest'
import { readExactBytes, readUploadBytes, sha256Hex } from './projectFilesBytes'

const signal = () => new AbortController().signal
function response(chunks: number[][], cancel?: () => void) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { chunks.forEach((chunk) => controller.enqueue(new Uint8Array(chunk))); controller.close() },
    cancel,
  }))
}

it('reads upload bytes without modifying them', async () => {
  const input = new Blob([new Uint8Array([0, 1, 127, 255])])
  assert.deepEqual(Array.from(new Uint8Array(await readUploadBytes(input, signal()))), [0, 1, 127, 255])
})
it('accepts an empty Markdown upload', async () => {
  assert.equal((await readUploadBytes(new Blob([]), signal())).byteLength, 0)
})
it('rejects an upload that was already canceled', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readUploadBytes(new Blob(['abc']), controller.signal), { name: 'AbortError' })
})
it('computes the standard lowercase SHA-256 digest', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  try {
    const bytes = new Uint8Array([97, 98, 99]).buffer
    assert.equal(await sha256Hex(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else Reflect.deleteProperty(globalThis, 'crypto')
  }
})
it('assembles exact download bytes across arbitrary chunk boundaries', async () => {
  const input = response([[1], [2, 3], [], [4, 5]])
  assert.deepEqual(Array.from(new Uint8Array(await readExactBytes(input, 5, signal()))), [1, 2, 3, 4, 5])
  assert.equal(input.body!.locked, false)
})
it('accepts an empty response for a zero-byte revision', async () => {
  assert.equal((await readExactBytes(new Response(null), 0, signal())).byteLength, 0)
})
it('accepts an empty stream for a zero-byte revision', async () => {
  assert.equal((await readExactBytes(response([]), 0, signal())).byteLength, 0)
})
it('rejects missing content for a non-empty revision', async () => {
  await assert.rejects(readExactBytes(new Response(null), 1, signal()), /missing/)
})
it('rejects truncated content and releases its stream lock', async () => {
  const input = response([[1, 2]])
  await assert.rejects(readExactBytes(input, 3, signal()), /truncated/)
  assert.equal(input.body!.locked, false)
})
it('cancels an oversized stream without buffering beyond the revision size', async () => {
  let canceled = false
  const input = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])) },
    cancel() { canceled = true },
  }))
  await assert.rejects(readExactBytes(input, 2, signal()), /exceeds/)
  assert.equal(canceled, true)
  assert.equal(input.body!.locked, false)
})
it('rejects non-empty content when the pinned revision is empty', async () => {
  await assert.rejects(readExactBytes(response([[1]]), 0, signal()), /exceeds/)
})
it('rejects invalid size inputs before consuming the stream', async () => {
  for (const size of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(readExactBytes(new Response(null), size, signal()), RangeError)
  }
})
it('propagates stream failures and releases the reader', async () => {
  const input = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('stream failed')) },
  }))
  await assert.rejects(readExactBytes(input, 1, signal()), /stream failed/)
  assert.equal(input.body!.locked, false)
})
it('aborts a blocked download read and cancels its stream', async () => {
  let canceled = false
  const controller = new AbortController()
  const input = new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true } }))
  const outcome = readExactBytes(input, 5, controller.signal)
  controller.abort()
  await assert.rejects(outcome, { name: 'AbortError' })
  assert.equal(canceled, true)
  assert.equal(input.body!.locked, false)
})
