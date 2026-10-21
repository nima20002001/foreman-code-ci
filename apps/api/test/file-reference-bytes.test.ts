import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'vitest'
import { decodeReferenceBytes, readReferenceRange } from '../src/modules/files/references/bytes.js'

// Dependency-free byte logic can also be exercised with Node's test runner after TS transpilation.
describe('FIL-36 bounded reference byte transport', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('a'), Buffer.from('ab'), Buffer.from('abc'), Buffer.from([0, 255, 128, 42])]) {
    it(`decodes canonical padded base64 for ${bytes.length} bytes`, () => {
      assert.deepEqual(decodeReferenceBytes(bytes.toString('base64'), bytes.length, 100), bytes)
    })
  }
  for (const encoded of ['YQ', 'YQ= ', 'YR==', 'YQ-=', 'YQ__', '====', '!!==', 'YQ==\n']) {
    it(`rejects noncanonical encoding ${JSON.stringify(encoded)}`, () => {
      assert.throws(() => decodeReferenceBytes(encoded, 1, 100))
    })
  }
  it('rejects wrong sizes and bounds before decoding', () => {
    for (const size of [-1, 0.1, Number.NaN, 101]) assert.throws(() => decodeReferenceBytes('', size, 100))
    assert.throws(() => decodeReferenceBytes('YWI=', 1, 100))
    assert.throws(() => decodeReferenceBytes('YQ==', 2, 100))
  })
  it('does not truncate a full 25 MiB add', () => {
    const bytes = Buffer.alloc(25 * 1024 * 1024, 97)
    assert.deepEqual(decodeReferenceBytes(bytes.toString('base64'), bytes.length, bytes.length), bytes)
    assert.throws(() => decodeReferenceBytes(bytes.toString('base64'), bytes.length, bytes.length - 1))
  })
  it('reads a range spanning multiple chunks without returning surrounding bytes', async () => {
    const source = Readable.from([Buffer.from('abc'), Buffer.from('defg'), Buffer.from('hijk')])
    assert.equal((await readReferenceRange(source, 2, 6, 11)).toString(), 'cdefgh')
    assert.equal(source.destroyed, true)
  })
  it('clips a final range at the immutable revision end', async () => {
    const source = Readable.from([Buffer.from('abc'), Buffer.from('def')])
    assert.equal((await readReferenceRange(source, 4, 64, 6)).toString(), 'ef')
    assert.equal(source.destroyed, true)
  })
  it('returns an empty EOF range and closes the descriptor', async () => {
    for (const size of [0, 10]) {
      const source = Readable.from([Buffer.alloc(size)])
      assert.deepEqual(await readReferenceRange(source, size, 64, size), Buffer.alloc(0))
      assert.equal(source.destroyed, true)
    }
  })
  it('rejects invalid ranges and always closes their descriptor', async () => {
    for (const [offset, length, size] of [[-1, 1, 5], [6, 1, 5], [0, 0, 5], [0.5, 1, 5], [0, 1, -1]]) {
      const source = Readable.from([Buffer.alloc(5)])
      await assert.rejects(readReferenceRange(source, offset!, length!, size!), RangeError)
      assert.equal(source.destroyed, true)
    }
  })
  it('does not acknowledge truncated content as a successful read', async () => {
    const source = Readable.from([Buffer.from('abc')])
    await assert.rejects(readReferenceRange(source, 2, 5, 10), /ended before/)
    assert.equal(source.destroyed, true)
  })
  it('rejects nonbinary chunks and closes the source', async () => {
    const source = Readable.from(['not a binary descriptor'])
    await assert.rejects(readReferenceRange(source, 0, 4, 4), TypeError)
    assert.equal(source.destroyed, true)
  })
  it('propagates storage read errors instead of fabricating EOF', async () => {
    const source = Readable.from((async function* () {
      yield Buffer.from('a')
      throw new Error('fixture I/O failure')
    })())
    await assert.rejects(readReferenceRange(source, 0, 10, 10), /fixture I\/O failure/)
    assert.equal(source.destroyed, true)
  })
})
