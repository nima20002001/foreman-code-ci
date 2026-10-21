import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  WorkflowArtifactOutputsV1Schema, WorkflowArtifactInputsV1Schema, WorkflowArtifactResultV1Schema,
  parseWorkflowArtifactResult,
  workflowArtifactDigestsByOutputKey,
} from './workflowArtifactResult.js'
import { makeCurrentWorkflowFixture } from './wave25/currentFixture.js'
import { WorkflowVersionV3Schema } from './wave25/saved.js'
import { parseChoiceResultEnvelope } from './wave25/currentResult.js'
import { parseRepeatExitResultV1 } from './wave25/repeat.js'
import { canonicalGraphJson } from './wave25/json.js'

const declaration = { version: 1 as const, outputKeys: ['report'] }
const artifacts = { version: 1, outputs: [{ outputKey: 'report', commandId: 'publish-report-original' }] }
const native = (value: unknown) => ({ outcome: 'succeeded', output: { text: JSON.stringify(value) } })
const choice = { outcomes: [{ outcome: 'ready', target: { kind: 'branch_end' as const } }] }

describe('saved original workflow artifact declarations and result association', () => {
  it('orders canonical digests by output key without rewriting mappings or deduplicating aliases', () => {
    const outputs = [{ outputKey: 'z', sha256: 'a'.repeat(64) }, { outputKey: 'a', sha256: 'b'.repeat(64) },
      { outputKey: 'a-alias', sha256: 'b'.repeat(64) }]
    const before = JSON.stringify(outputs)
    expect(workflowArtifactDigestsByOutputKey(outputs)).toEqual(['b'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)])
    expect(JSON.stringify(outputs)).toBe(before)
    expect(workflowArtifactDigestsByOutputKey([])).toEqual([])
    expect(() => workflowArtifactDigestsByOutputKey([outputs[0]!, outputs[0]!])).toThrow()
    expect(() => workflowArtifactDigestsByOutputKey([{ outputKey: 'bad', sha256: 'caller-hash' }])).toThrow()
  })
  it('retains exact declarations through the current immutable version and changes complete definition identity', () => {
    const f = makeCurrentWorkflowFixture('artifact', 'sequential')
    const before = canonicalGraphJson(f.version.definition)
    const input = { ...f.version, definition: { ...f.version.definition,
      nodes: f.version.definition.nodes.map((node, index) => index ? node : { ...node, artifactOutputs: declaration }),
      edges: f.version.definition.edges.map(edge => ({ ...edge, artifactInputs: declaration })),
    } }
    const version = WorkflowVersionV3Schema.parse(input)
    expect(version.definition.nodes[0]).toMatchObject({ artifactOutputs: declaration })
    expect(version.definition.edges[0]).toMatchObject({ artifactInputs: declaration })
    expect(canonicalGraphJson(version.definition)).not.toBe(before)
    expect(WorkflowVersionV3Schema.parse(f.version)).toEqual(f.version)
  })
  it.each(['approval', 'bidirectional', 'undeclared', 'missing-declaration'] as const)('rejects %s edge authority', reason => {
    const f = makeCurrentWorkflowFixture('edge-' + reason, 'sequential')
    const input = { ...f.version, definition: { ...f.version.definition,
      nodes: f.version.definition.nodes.map((node, index) => index || reason === 'missing-declaration' ? node : { ...node, artifactOutputs: declaration }),
      edges: f.version.definition.edges.map(edge => ({ ...edge,
        kind: reason === 'approval' ? 'approval' : 'execution',
        ...(reason === 'bidirectional' ? { workRequestDirection: 'both' } : {}),
        artifactInputs: reason === 'undeclared' ? { ...declaration, outputKeys: ['foreign'] } : declaration,
      })),
    } }
    expect(WorkflowVersionV3Schema.safeParse(input).success).toBe(false)
  })
  it.each([null, { version: 1, outputKeys: [] }, { version: 1, outputKeys: ['same', 'same'] },
    { version: 1, outputKeys: [''] }, { version: 2, outputKeys: ['report'] },
    { version: 1, outputKeys: Array.from({ length: 65 }, (_, index) => String(index)) },
    { ...declaration, pins: {} }])('rejects invalid saved declarations %j', value => {
    expect(WorkflowArtifactOutputsV1Schema.safeParse(value).success).toBe(false)
    expect(WorkflowArtifactInputsV1Schema.safeParse(value).success).toBe(false)
  })
  it('parses original successful text without changing bytes and permits explicit aliases to one original command', () => {
    const envelope = { data: { summary: 'Ready' }, artifactOutputs: artifacts }
    const original = native(envelope), bytes = canonicalGraphJson(original)
    expect(parseWorkflowArtifactResult(original, declaration)).toEqual(envelope)
    expect(canonicalGraphJson(original)).toBe(bytes)
    const alias = { version: 1 as const, outputKeys: ['report', 'report_alias'] }
    const result = { data: null, artifactOutputs: { version: 1, outputs: [artifacts.outputs[0], { ...artifacts.outputs[0], outputKey: 'report_alias' }] } }
    expect(parseWorkflowArtifactResult(native(result), alias)).toEqual(result)
  })
  it.each([
    { version: 1, outputs: [] },
    { version: 1, outputs: [{ outputKey: 'foreign', commandId: 'publish-original' }] },
    { version: 1, outputs: [artifacts.outputs[0], artifacts.outputs[0]] },
    { version: 1, outputs: [{ outputKey: 'report' }] },
    { version: 1, outputs: [{ outputKey: 'report', commandId: '' }] },
    { version: 1, outputs: [{ ...artifacts.outputs[0], fileId: 'caller-pin' }] },
  ])('rejects incomplete, undeclared or caller-invented associations %j', artifactOutputs => {
    expect(() => parseWorkflowArtifactResult(native({ data: null, artifactOutputs }), declaration)).toThrow()
  })
  it.each([
    { outcome: 'failed', error: { code: 'FAILED', message: 'failed', retryable: false } },
    { outcome: 'succeeded', output: { data: null, artifactOutputs: artifacts } },
    { outcome: 'succeeded', output: { text: '{}', extra: true } },
    { outcome: 'succeeded', output: { text: '```json\n{}\n```' } },
    native({ data: null, artifactOutputs: artifacts, callerAuthority: {} }),
    native({ data: 'x'.repeat(64 * 1024), artifactOutputs: artifacts }),
  ])('rejects unsuccessful, mixed, partial or oversized native carriers %j', result => {
    expect(() => parseWorkflowArtifactResult(result, declaration)).toThrow()
  })
  it('keeps named choice parsing declaration aware and ordinary undeclared parsing strict', () => {
    const value = { routing: { outcome: 'ready' }, data: { unchanged: true }, artifactOutputs: artifacts }
    const result = native(value)
    expect(parseWorkflowArtifactResult(result, declaration, choice)).toEqual(value)
    expect(parseChoiceResultEnvelope(result, choice, declaration)).toEqual(value)
    expect(() => parseChoiceResultEnvelope({ ...result, output: result.output.text }, choice)).toThrow()
    expect(() => parseWorkflowArtifactResult(native({ ...value, routing: { outcome: 'foreign' } }), declaration, choice)).toThrow('CHOICE_OUTCOME_UNDECLARED')
    expect(() => parseWorkflowArtifactResult(native(value), declaration)).toThrow()
    expect(parseChoiceResultEnvelope({ outcome: 'succeeded', output: { routing: { outcome: 'ready' }, data: null } }, choice)).toEqual({ routing: { outcome: 'ready' }, data: null })
  })
  it('retains exact repeat carry data and original native text for declared outputs', () => {
    const data = { latestDeliverable: { text: 'unchanged' }, remainingFindings: [] }
    const value = { routing: { outcome: 'ready' }, data, artifactOutputs: artifacts }
    const result = native(value), bytes = canonicalGraphJson(result)
    expect(parseRepeatExitResultV1(result, choice, declaration)).toEqual(value)
    expect(canonicalGraphJson(result)).toBe(bytes)
    expect(() => parseRepeatExitResultV1(native({ ...value, data: { ...data, extra: true } }), choice, declaration)).toThrow()
  })
  it('keeps result mapping a strict association without file or authority claims', () => {
    expect(WorkflowArtifactResultV1Schema.parse(artifacts)).toEqual(artifacts)
    expect(WorkflowArtifactResultV1Schema.safeParse({ ...artifacts, transferReceipt: {} }).success).toBe(false)
  })
  // Five cold Node starts: run them together, and allow for a loaded CI machine.
  it('loads declaration/result and existing shape modules as fresh first ESM imports', async () => {
    const names = ['workflowArtifactDeclarations', 'workflowArtifactResult', 'wave25/workflowShape', 'wave25/currentResult', 'index']
    const results = await Promise.all(names.map(name => new Promise<{ code: number | null; stderr: string }>(resolve => {
      const url = new URL(`../dist/${name}.js`, import.meta.url).href
      const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`])
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('close', code => resolve({ code, stderr }))
    })))
    for (const result of results) expect(result.code, result.stderr).toBe(0)
  }, 30_000)
})
