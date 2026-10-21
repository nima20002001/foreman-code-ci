import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalGraphJson, canonicalJson, canonicalJsonLocaleOrderLegacy, canonicalJsonNumericKeysFirstLegacy, canonicalJsonValueLegacy,
} from './canonicalJson.js'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
// Hashes below were produced by the pre-consolidation local helpers and are stored in existing databases.
const fixture = { workspaceId: 'w-1', name: 'Fixture', items: [{ b: 2, a: 1 }, 'é☃'], Upper: 1, lower: 2, '10': 'ten', '9': 'nine', omitted: undefined }

describe('canonicalJson', () => {
  it('sorts nested keys by code unit and ignores insertion order', () => {
    expect(canonicalJson({ b: { d: [{ z: 1, y: 2 }], c: 3 }, a: 1 })).toBe('{"a":1,"b":{"c":3,"d":[{"y":2,"z":1}]}}')
    expect(canonicalJson({ a: 1, B: 2, _: 3, '10': 4, '9': 5 })).toBe('{"10":4,"9":5,"B":2,"_":3,"a":1}')
    expect(canonicalJson(['b', 'a'])).not.toBe(canonicalJson(['a', 'b']))
  })

  it('omits undefined properties, writes undefined array items as null and keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [undefined, null, 1] })).toBe('{"b":null,"c":[null,null,1]}')
  })

  it('writes numbers, unicode and escapes exactly as JSON.stringify', () => {
    expect(canonicalJson({ n: [-0, 1.5e-7, 12345678901234, Number.NaN], s: 'é ☃ 😀 "q"\n' }))
      .toBe('{"n":[0,1.5e-7,12345678901234,null],"s":"é ☃ 😀 \\"q\\"\\n"}')
  })

  it('matches the strict bounded graph serializer for every value that serializer accepts', () => {
    const value = { z: [1, { y: null, x: 'é' }], '10': true, '9': -0, A: 'snow ☃' }
    expect(canonicalGraphJson(value)).toBe(canonicalJson(value))
    expect(() => canonicalGraphJson({ a: undefined })).toThrow('GRAPH_JSON_INVALID')
  })

  it('keeps the stored job digest bytes', () => {
    expect(canonicalJson(fixture)).toBe('{"10":"ten","9":"nine","Upper":1,"items":[{"a":1,"b":2},"é☃"],"lower":2,"name":"Fixture","workspaceId":"w-1"}')
    expect(sha256(canonicalJson(fixture))).toBe('504b02bd905d77d2f4f3cb1b91ed456e37045cac559e7d0e1d4582318c30aa7a')
  })
})

describe('canonicalJsonLocaleOrderLegacy', () => {
  it('keeps the stored command, source-operation and telemetry selector bytes', () => {
    expect(canonicalJsonLocaleOrderLegacy(fixture))
      .toBe('{"10":"ten","9":"nine","items":[{"a":1,"b":2},"é☃"],"lower":2,"name":"Fixture","omitted":undefined,"Upper":1,"workspaceId":"w-1"}')
    expect(sha256(canonicalJsonLocaleOrderLegacy(fixture))).toBe('d9ba606689b8770d0cf536866d3224bac0cdbfcb97e2cac0e66e3f1b9197617b')
    expect(canonicalJsonLocaleOrderLegacy([1, undefined, null])).toBe('[1,,null]')
  })
})

describe('canonicalJsonNumericKeysFirstLegacy', () => {
  it('keeps the stored Operator configuration and Codex identity bytes', () => {
    expect(canonicalJsonNumericKeysFirstLegacy(fixture))
      .toBe('{"9":"nine","10":"ten","Upper":1,"items":[{"a":1,"b":2},"é☃"],"lower":2,"name":"Fixture","workspaceId":"w-1"}')
    expect(sha256(canonicalJsonNumericKeysFirstLegacy(fixture))).toBe('b23a4667189114a5a8dff9bc82d18cb2ed481d89edd7b5948a189cc922c1e87c')
    expect(canonicalJsonNumericKeysFirstLegacy(undefined)).toBe('null')
    expect(canonicalJsonNumericKeysFirstLegacy([undefined])).toBe('[null]')
  })

  it('exposes the same order as a value for embedding in a larger record', () => {
    expect(JSON.stringify({ harness: canonicalJsonValueLegacy(fixture) })).toBe(`{"harness":${canonicalJsonNumericKeysFirstLegacy(fixture)}}`)
  })
})


describe('canonicalGraphJson byte accounting', () => {
  it('counts a fragmented document without allocating an encoded buffer for each fragment', () => {
    const value = Array.from({ length: 1000 }, (_, index) => ({ index, value: 'é☃😀' }))
    const expected = canonicalJson(value)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      expect(canonicalGraphJson(value, Buffer.byteLength(expected))).toBe(expected)
      expect(encode.mock.calls.length).toBeLessThanOrEqual(1)
    } finally { encode.mockRestore() }
  })

  it.each(['', 'ascii', 'é', '☃', '😀', '\ud800', '\udc00', '\ud800x\udc00', '"\\\n\u0000'])(
    'preserves JSON bytes and the exact UTF-8 boundary for %j in values and keys', text => {
      const value = { [text]: [text, null, true, false, -0, 1.5e-7] }
      const expected = canonicalJson(value)
      const bytes = Buffer.byteLength(expected)
      expect(canonicalGraphJson(value, bytes)).toBe(expected)
      expect(canonicalGraphJson(value, bytes + 1)).toBe(expected)
      expect(() => canonicalGraphJson(value, bytes - 1)).toThrow('GRAPH_JSON_LIMIT')
    })

  it('retains empty-document, depth, node and invalid-input limits', () => {
    expect(canonicalGraphJson('', 2)).toBe('""')
    expect(() => canonicalGraphJson('', 1)).toThrow('GRAPH_JSON_LIMIT')
    expect(() => canonicalGraphJson(null, 0)).toThrow('GRAPH_JSON_LIMIT')
    for (const limit of [-1, 0.5, Infinity, NaN]) {
      expect(() => canonicalGraphJson(null, limit)).toThrow('GRAPH_JSON_LIMIT')
    }
    let nested: unknown = null
    for (let depth = 0; depth < 33; depth++) nested = [nested]
    expect(() => canonicalGraphJson(nested)).toThrow('GRAPH_JSON_LIMIT')
    expect(() => canonicalGraphJson(Array(100_000).fill(null))).toThrow('GRAPH_JSON_LIMIT')
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    for (const invalid of [undefined, Infinity, new Date(), cyclic, Object.assign(new Array<unknown>(2), { 1: 1 }), { get value() { throw new Error('getter evaluated') } }]) {
      expect(() => canonicalGraphJson(invalid)).toThrow('GRAPH_JSON_INVALID')
    }
  })
})
