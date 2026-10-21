import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  AcceptedCurrentNodeResultSchema, canonicalGraphJson, parseChoiceResultEnvelope,
} from '@foreman-code/contracts/wave25'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { normalizeRepeatTerminal, repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { bindRepeatNodeInput, repeatExecutionIdentity } from '../src/modules/runs/repeatResolution.js'
import { parseCurrentChoiceResult } from '../src/modules/runs/currentRouting.js'
import {
  br2001Fixture, br2001InvalidTexts, br2001Providers, br2001Terminal, br2001Text,
} from './helpers/wave25Br2001Choice.js'

/** Production normalization, strict schemas, resolution and input binding. No DB,
 * native process, coordinator, credential or provider execution in this suite. */
describe.each(br2001Providers)('BR2-001: %s final-text choice carrier', (provider) => {
  it.each(['pass', 'issues'])('accepts complete %s text without rewriting provider evidence', (outcome) => {
    const f = br2001Fixture(provider, `br2001-${provider}-${outcome}`)
    const terminal = br2001Terminal(f.executions[0]!, provider, br2001Text(outcome, { checks: ['one', 'two'] }))
    const before = structuredClone(terminal.execution)
    Object.freeze(terminal.result.output)
    Object.freeze(terminal.result)
    Object.freeze(terminal.execution.result)
    Object.freeze(terminal.execution)
    const envelope = parseCurrentChoiceResult(terminal.result, f.version.definition.nodes[0]!.choice!)
    expect(envelope).toEqual({ routing: { outcome }, data: { checks: ['one', 'two'] } })
    expect(terminal.execution).toEqual(before)
    const normalized = normalizeRepeatTerminal(f.version, f.scope, { nodeId: terminal.execution.workflowNodeId, occurrence: null }, terminal.execution)
    expect(normalized).toEqual(before)
    expect(terminal.execution).toEqual(before)
    expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: normalized.workflowNodeId, occurrence: null }, normalized)).toEqual(normalized)
    // Exercise the later acceptance/recovery boundary too, not normalization alone.
    const resolution = repeatTerminalResolution(f.version, f.scope, { nodeId: normalized.workflowNodeId, occurrence: null }, normalized).value
    expect(repeatTerminalResolution(f.version, f.scope, { nodeId: terminal.execution.workflowNodeId, occurrence: null }, terminal.execution).value).toEqual(resolution)
    expect(resolution.resolution).toBe('succeeded')
    expect(resolution.outcome).toBe(outcome)
    expect(resolution.branchEnded).toBe(outcome === 'pass')
    expect(resolution.selectedRelationshipIds).toEqual(outcome === 'issues' ? [f.version.definition.edges[0]!.id] : [])
    expect(resolution.unselectedRelationshipIds).toEqual(outcome === 'pass' ? [f.version.definition.edges[0]!.id] : [])
    expect(resolution.acceptedResultDigest).toBe(graphSourceDigest(terminal.result))
    expect(resolution.acceptedResultDigest).not.toBe(graphSourceDigest({ outcome: 'succeeded', output: terminal.result.output.text }))
    // This is a local adaptation, not a relaxed shared contract.
    expect(() => parseChoiceResultEnvelope(terminal.result, f.version.definition.nodes[0]!.choice!)).toThrow()
  })

  it.each(br2001InvalidTexts)('rejects $name with a safe failure and no fallback route', ({ text }) => {
    const f = br2001Fixture(provider, `br2001-invalid-${provider}`)
    const terminal = br2001Terminal(f.executions[0]!, provider, text)
    const before = structuredClone(terminal.execution)
    const normalized = normalizeRepeatTerminal(f.version, f.scope, { nodeId: terminal.execution.workflowNodeId, occurrence: null }, terminal.execution)
    expect(normalized).toEqual({ ...before, result: { outcome: 'failed', error: {
      code: 'REPEAT_RESULT_INVALID',
      message: 'The complete result did not satisfy its pinned bounded result contract.', retryable: false,
    } } })
    expect(terminal.execution).toEqual(before)
    const resolution = repeatTerminalResolution(f.version, f.scope, { nodeId: normalized.workflowNodeId, occurrence: null }, normalized).value
    expect(resolution.resolution).toBe('failed')
    expect(resolution.outcome).toBeUndefined()
    expect(resolution.acceptedResultDigest).toBeUndefined()
    expect(resolution.branchEnded).toBe(false)
    expect(resolution.selectedRelationshipIds).toEqual([])
    expect(resolution.unselectedRelationshipIds).toEqual([f.version.definition.edges[0]!.id])
    expect(() => repeatTerminalResolution(f.version, f.scope, { nodeId: terminal.execution.workflowNodeId, occurrence: null }, terminal.execution).value).toThrow()
    expect(() => parseCurrentChoiceResult(terminal.result, f.version.definition.nodes[0]!.choice!)).toThrow()
  })

  it('rejects mixed, nested, non-string and array carriers instead of discarding their fields', () => {
    const f = br2001Fixture(provider, `br2001-carrier-${provider}`)
    const text = br2001Text()
    for (const output of [
      { text, extra: true }, { text, routing: { outcome: 'issues' }, data: null },
      { text: JSON.parse(text) }, { text: null }, { text: 0 }, { output: { text } }, [{ text }],
    ]) {
      const terminal = br2001Terminal(f.executions[0]!, provider, text).execution
      const input = HarnessExecutionSchema.parse({ ...terminal, result: { outcome: 'succeeded', output } })
      expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input).result).toMatchObject({
        outcome: 'failed', error: { code: 'REPEAT_RESULT_INVALID', retryable: false },
      })
      expect(() => repeatTerminalResolution(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input).value).toThrow()
      expect(() => parseCurrentChoiceResult(input.result!, f.version.definition.nodes[0]!.choice!)).toThrow()
    }
  })

  it('keeps the original complete-result byte limit before unwrapping', () => {
    const f = br2001Fixture(provider, `br2001-bound-${provider}`)
    const empty = br2001Terminal(f.executions[0]!, provider, br2001Text('pass', ''))
    const overhead = Buffer.byteLength(canonicalGraphJson(empty.result), 'utf8')
    const data = 'x'.repeat(64 * 1024 - overhead)
    const atLimit = br2001Terminal(f.executions[0]!, provider, br2001Text('pass', data))
    expect(Buffer.byteLength(canonicalGraphJson(atLimit.result), 'utf8')).toBe(64 * 1024)
    expect(AcceptedCurrentNodeResultSchema.safeParse(atLimit.result).success).toBe(true)
    expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: atLimit.execution.workflowNodeId, occurrence: null }, atLimit.execution)).toEqual(atLimit.execution)
    expect(parseCurrentChoiceResult(atLimit.result, f.version.definition.nodes[0]!.choice!))
      .toEqual({ routing: { outcome: 'pass' }, data })
    const overLimit = br2001Terminal(f.executions[0]!, provider, br2001Text('pass', data + 'x'))
    expect(AcceptedCurrentNodeResultSchema.safeParse(overLimit.result).success).toBe(false)
    // Removing the carrier would fit: accepting this would silently relax the old limit.
    expect(AcceptedCurrentNodeResultSchema.safeParse({ ...overLimit.result, output: overLimit.result.output.text }).success).toBe(true)
    expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: overLimit.execution.workflowNodeId, occurrence: null }, overLimit.execution).result).toMatchObject({ outcome: 'failed' })
    expect(() => repeatTerminalResolution(f.version, f.scope, { nodeId: overLimit.execution.workflowNodeId, occurrence: null }, overLimit.execution).value).toThrow()
    // A persistence caller must not rely on normalization having already enforced this limit.
    expect(() => parseCurrentChoiceResult(overLimit.result, f.version.definition.nodes[0]!.choice!)).toThrow()
  })

  it('passes the unchanged accepted carrier and digest to the selected Fixer input', () => {
    const f = br2001Fixture(provider, `br2001-bind-${provider}`)
    const terminal = br2001Terminal(f.executions[0]!, provider, br2001Text('issues', { detail: 'needs fix' }))
    const execution = normalizeRepeatTerminal(f.version, f.scope, { nodeId: terminal.execution.workflowNodeId, occurrence: null }, terminal.execution)
    const resolution = repeatTerminalResolution(f.version, f.scope, { nodeId: execution.workflowNodeId, occurrence: null }, execution).value
    const source = { relationshipId: f.version.definition.edges[0]!.id,
      execution: repeatExecutionIdentity(execution), occurrence: null,
      acceptedResult: terminal.result, acceptedResultDigest: resolution.acceptedResultDigest! }
    const bound = bindRepeatNodeInput({ version: f.version, runInput: f.run.input, recipient: f.executions[1]!,
      ref: { nodeId: f.executions[1]!.workflowNodeId, occurrence: null }, occurrence: null, entry: null, predecessors: [source] })
    expect(bound.input).toEqual({ executionSemanticsVersion: 3, runInput: f.run.input,
      occurrence: null, entry: null, predecessors: [source] })
    expect(bound.bindings).toHaveLength(1)
    expect(bound.bindings[0]!.source.acceptedResultDigest).toBe(graphSourceDigest(terminal.result))
  })

  it('preserves direct string/object choices, JSON whitespace and ordinary non-choice results', () => {
    const f = br2001Fixture(provider, `br2001-compatible-${provider}`)
    const base = br2001Terminal(f.executions[0]!, provider, br2001Text()).execution
    for (const output of [br2001Text(), JSON.parse(br2001Text()), { text: ` \n${br2001Text()}\t ` }]) {
      const input = HarnessExecutionSchema.parse({ ...base, result: { outcome: 'succeeded', output } })
      expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input)).toEqual(input)
      expect(repeatTerminalResolution(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input).value.outcome).toBe('pass')
      expect(parseCurrentChoiceResult(input.result!, f.version.definition.nodes[0]!.choice!))
        .toEqual({ routing: { outcome: 'pass' }, data: null })
    }
    delete f.version.definition.nodes[0]!.choice
    for (const output of [{ text: 'Ordinary non-JSON reply.' }, { text: br2001Text(), extra: true }, 'plain text', { done: true }]) {
      const input = HarnessExecutionSchema.parse({ ...base, result: { outcome: 'succeeded', output } })
      expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input)).toEqual(input)
      const resolution = repeatTerminalResolution(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input).value
      expect(resolution.outcome).toBeUndefined()
      expect(resolution.branchEnded).toBe(false)
      expect(resolution.selectedRelationshipIds).toEqual([f.version.definition.edges[0]!.id])
      expect(resolution.acceptedResultDigest).toBe(graphSourceDigest(input.result))
    }
  })

  it('does not reinterpret failed/canceled or nonterminal evidence, or relax identity pins', () => {
    const f = br2001Fixture(provider, `br2001-fences-${provider}`)
    const base = br2001Terminal(f.executions[0]!, provider, br2001Text()).execution
    for (const result of [{ outcome: 'canceled' }, { outcome: 'failed', error: {
      code: 'NATIVE_FAILED', message: 'Explicit native failure.', retryable: false,
    } }]) {
      const input = HarnessExecutionSchema.parse({ ...base, result })
      expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input)).toEqual(input)
      expect(repeatTerminalResolution(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input).value.selectedRelationshipIds).toEqual([])
      expect(() => parseCurrentChoiceResult(input.result!, f.version.definition.nodes[0]!.choice!)).toThrow()
    }
    const queued = f.executions[0]!
    expect(normalizeRepeatTerminal(f.version, f.scope, { nodeId: queued.workflowNodeId, occurrence: null }, queued)).toEqual(queued)
    expect(() => repeatTerminalResolution(f.version, f.scope, { nodeId: queued.workflowNodeId, occurrence: null }, queued).value).toThrow()
    for (const input of [{ ...base, attempt: 0 }, { ...base, agentConfigurationVersionId: 'different-pin' }]) {
      expect(() => normalizeRepeatTerminal(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input)).toThrow()
      expect(() => repeatTerminalResolution(f.version, f.scope, { nodeId: input.workflowNodeId, occurrence: null }, input).value).toThrow()
    }
  })
})
