import { describe, expect, it } from 'vitest'
import { encodeResultCopies, decodeResultCopies, historyResultPaths } from './executionResultCodec.js'

describe('execution result dictionaries', () => {
  it('deduplicates only explicit result slots and preserves arbitrary user JSON', () => {
    const result = { outcome: 'succeeded' as const, output: { data: {
      kind: 'execution-result-dictionary', results: [null], locations: [{ path: ['private'], index: 0 }],
      nested: { result: { outcome: 'failed' } },
    } } }
    const history = { pendingInteractions: [], terminalResult: result,
      terminalTurn: { correlationId: 'original', providerId: 'turn', result } }
    const encoded = encodeResultCopies(history, historyResultPaths())
    expect(encoded.results).toEqual([result])
    expect(decodeResultCopies(encoded)).toEqual(history)
    const distinct = { ...history, terminalResult: { outcome: 'canceled' as const } }
    const other = encodeResultCopies(distinct, historyResultPaths())
    expect(other.results).toHaveLength(2)
    expect(decodeResultCopies(other)).toEqual(distinct)
  })

  it('rejects missing slots, duplicate replacements and unbound result indexes', () => {
    const result = { outcome: 'succeeded' as const }
    const dictionary = encodeResultCopies({ terminalResult: result }, historyResultPaths())
    expect(() => decodeResultCopies({ ...dictionary,
      locations: [{ path: ['missing'], index: 0 }] })).toThrow('location changed')
    expect(() => decodeResultCopies({ ...dictionary,
      locations: [dictionary.locations[0], dictionary.locations[0]] })).toThrow('location changed')
    expect(() => decodeResultCopies({ ...dictionary,
      locations: [{ path: ['terminalResult'], index: 1 }] })).toThrow('location changed')
    expect(() => decodeResultCopies({ ...dictionary, locations: [] })).toThrow('unbound payload')
    expect(() => decodeResultCopies({ ...dictionary, results: [result, result] })).toThrow('repeats a payload')
    expect(() => decodeResultCopies({ ...dictionary,
      results: [{ outcome: 'failed' }] })).toThrow('failed result requires an error')
  })
})
