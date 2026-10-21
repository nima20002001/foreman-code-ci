import { describe, expect, it } from 'vitest'
import { RunAcceptedInputValueSchema } from './runInspection.js'

const input = { executionSemanticsVersion: 3, runInput: { prompt: 'Observe the Run' },
  occurrence: null, entry: null, predecessors: [], tick: { index: 1, everySeconds: 10 } }

describe('interval accepted input inspection', () => {
  it('retains the exact tick input alongside ordinary graph input', () => {
    expect(RunAcceptedInputValueSchema.parse(input)).toEqual(input)
    const graph = { executionSemanticsVersion: 3, runInput: input.runInput,
      occurrence: null, entry: null, predecessors: [] }
    expect(RunAcceptedInputValueSchema.parse(graph)).toEqual(graph)
  })
  it.each([1001, 1_000_000])('retains tick %i for a Run that continues until Stop', index => {
    const value = { ...input, tick: { ...input.tick, index } }
    expect(RunAcceptedInputValueSchema.parse(value)).toEqual(value)
  })
  it.each([
    { index: 0, everySeconds: 10 },
    { index: 1.5, everySeconds: 10 }, { index: 1, everySeconds: 9 },
    { index: 1, everySeconds: 86401 }, { index: 1, everySeconds: 10, extra: true },
  ])('rejects malformed tick metadata %j', tick => {
    expect(RunAcceptedInputValueSchema.safeParse({ ...input, tick }).success).toBe(false)
  })
  it('rejects extra input fields and a check masquerading as a repeat occurrence', () => {
    expect(RunAcceptedInputValueSchema.safeParse({ ...input, unknown: true }).success).toBe(false)
    expect(RunAcceptedInputValueSchema.safeParse({ ...input, occurrence: {} }).success).toBe(false)
    expect(RunAcceptedInputValueSchema.safeParse({ ...input, entry: {} }).success).toBe(false)
  })
})
