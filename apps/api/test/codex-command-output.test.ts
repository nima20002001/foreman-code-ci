import { expect, it } from 'vitest'
import { CodexCommandOutput, recordedCodexCommandOutput } from '../src/modules/harnesses/codexCommandOutput.js'

const command = { threadId: 'thread', turnId: 'turn', itemId: 'command' }

it('retains original command deltas when the completed item has no aggregated output', () => {
  const output = new CodexCommandOutput()
  output.append({ ...command, delta: '{"marker":' })
  output.append({ ...command, delta: '"original"}\n' })
  expect(output.read(command, null)).toBe('{"marker":"original"}\n')
  expect(output.read(command, 'native aggregate')).toBe('native aggregate')
  expect(output.read(command, '')).toBe('')
  expect(new CodexCommandOutput().read(command, null)).toBeUndefined()
})

it('separates command output from other threads, turns, items and reconstructed transports', () => {
  const output = new CodexCommandOutput()
  output.append({ ...command, delta: 'original' })
  for (const identity of [{ ...command, threadId: 'other' }, { ...command, turnId: 'other' },
    { ...command, itemId: 'other' }]) {
    expect(output.read(identity, null)).toBeUndefined()
    output.append({ ...identity, delta: 'foreign' })
  }
  expect(output.read(command, null)).toBe('original')
  expect(new CodexCommandOutput().read(command, null)).toBeUndefined()
})

it('captures the original completed native function result with string and text-part output', () => {
  const output = new CodexCommandOutput()
  output.complete({ ...command, output: 'native stdout' })
  expect(output.read(command, null)).toBe('native stdout')
  expect(output.read({ ...command, turnId: 'foreign' }, null)).toBeUndefined()
  expect(output.read({ ...command, threadId: 'foreign' }, null)).toBeUndefined()
  expect(output.read({ ...command, itemId: 'foreign' }, null)).toBeUndefined()
  output.complete({ ...command, output: [{ type: 'input_text', text: 'native stdout' }] })
  expect(() => output.complete({ ...command, output: 'changed stdout' })).toThrow('result changed')
  const invalid = new CodexCommandOutput()
  invalid.complete({ ...command, output: [{ type: 'output_text', text: 'assistant claim' }] })
  expect(invalid.read(command, null)).toBeUndefined()
  expect(() => invalid.complete({ ...command, output: 'x'.repeat(64 * 1024 + 1) })).toThrow('exceeds its bound')
})

it('fails oversized diagnostic capture without truncating it into acceptable evidence', () => {
  const output = new CodexCommandOutput()
  output.append({ ...command, delta: 'a'.repeat(64 * 1024) })
  expect(() => output.append({ ...command, delta: 'b' })).toThrow('exceeds its bound')
  expect(output.read(command, null)).toHaveLength(64 * 1024)
})

it('reads only the matching completed command from authoritative item history', () => {
  const expected = { turnId: 'turn', itemId: 'command', command: '/usr/bin/python3 original.py' }
  const row = { turnId: expected.turnId, item: { id: expected.itemId, type: 'commandExecution',
    command: expected.command, status: 'completed', exitCode: 0, aggregatedOutput: 'original stdout' } }
  expect(recordedCodexCommandOutput([row], expected)).toBe('original stdout')
  for (const foreign of [{ ...row, turnId: 'foreign' },
    ...[{ id: 'foreign' }, { command: 'different command' }, { type: 'agentMessage' },
      { status: 'inProgress' }, { exitCode: 1 }, { aggregatedOutput: null }]
      .map(fields => ({ ...row, item: { ...row.item, ...fields } }))]) {
    expect(recordedCodexCommandOutput([foreign], expected)).toBeUndefined()
  }
  expect(recordedCodexCommandOutput([row, row], expected)).toBeUndefined()
})
