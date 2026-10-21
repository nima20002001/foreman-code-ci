import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { RemoteWorkflowPhysicalOutputSchema, remoteWorkflowPhysicalOutput } from './remoteWorkflowPhysical.js'
import { RemoteTerminalEvidenceSchema } from './remoteExecution.js'
import type { ExecutionResult } from './index.js'

const artifactOutputs = { version: 1, outputs: [{ outputKey: 'report', commandId: 'publish-original-report' }] }
const native = (envelope: unknown): ExecutionResult => ({ outcome: 'succeeded', output: { text: JSON.stringify(envelope) } })
const published = () => ({ kind: 'published-artifacts', artifactOutputs, result: native({ data: null, artifactOutputs }) })

describe('original remote physical artifact association', () => {
  it('keeps artifact validation separate from original success and refuses mixed terminal facts', () => {
    const terminal = { kind: 'completed', closureEvidenceDigest: 'a'.repeat(64),
      result: native({ data: null }), artifactDigests: [],
      artifactValidationError: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT', reason: 'invalid_result' } }
    expect(RemoteTerminalEvidenceSchema.parse(terminal)).toEqual(terminal)
    for (const changed of [{ ...terminal, kind: 'failed' }, { ...terminal, result: { outcome: 'canceled' } },
      { ...terminal, artifactDigests: ['b'.repeat(64)] }]) {
      expect(RemoteTerminalEvidenceSchema.safeParse(changed).success).toBe(false)
    }
  })
  it('preserves existing text-only results and rejects nontext output', () => {
    for (const result of [{ outcome: 'succeeded' }, native('plain'), { outcome: 'canceled' },
      { outcome: 'failed', error: { code: 'FAILED', message: 'failed', retryable: false } }]) {
      const output = { kind: 'text-only', result }
      expect(RemoteWorkflowPhysicalOutputSchema.parse(output)).toEqual(output)
    }
    expect(RemoteWorkflowPhysicalOutputSchema.safeParse({ kind: 'text-only', result: { outcome: 'succeeded', output: artifactOutputs } }).success).toBe(false)
  })
  it('preserves the original result bytes for ordinary and choice associations', () => {
    for (const envelope of [{ data: null, artifactOutputs }, { data: { carry: 1 }, routing: { outcome: 'ready' }, artifactOutputs }]) {
      const output = { ...published(), result: native(envelope) }
      const before = JSON.stringify(output)
      expect(RemoteWorkflowPhysicalOutputSchema.parse(output)).toEqual(output)
      expect(JSON.stringify(output)).toBe(before)
    }
  })
  it('carries the combined handoff and artifact association from the original native result', () => {
    for (const routing of [{ kind: 'finish' }, { kind: 'request', outcome: 'review' },
      { kind: 'return', requestId: 'original-request', outcome: 'accepted' }]) {
      const result = native({ routing, data: { latestDeliverable: { revision: 1 }, remainingFindings: [] }, artifactOutputs })
      const output = remoteWorkflowPhysicalOutput(result, { version: 1, outputKeys: ['report'] })
      expect(output).toEqual({ kind: 'published-artifacts', result, artifactOutputs })
      expect(RemoteWorkflowPhysicalOutputSchema.parse(output)).toEqual(output)
      expect(remoteWorkflowPhysicalOutput(result, { version: 1, outputKeys: ['another'] })).toEqual({
        kind: 'invalid-artifacts', result,
        failure: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT', reason: 'invalid_result' },
      })
    }
    const missing = native({ routing: { kind: 'finish' }, data: { latestDeliverable: {}, remainingFindings: [] } })
    expect(remoteWorkflowPhysicalOutput(missing, { version: 1, outputKeys: ['report'] })).toEqual({
      kind: 'invalid-artifacts', result: missing,
      failure: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT', reason: 'invalid_result' },
    })
  })
  it.each([
    { ...published(), artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId: 'foreign-command' }] } },
    { ...published(), artifactOutputs: { version: 1, outputs: [] } },
    { ...published(), artifactOutputs: { version: 1, outputs: [artifactOutputs.outputs[0], artifactOutputs.outputs[0]] } },
    { ...published(), result: { outcome: 'canceled' } },
    { ...published(), result: { outcome: 'succeeded', output: { data: null, artifactOutputs } } },
    { ...published(), result: { outcome: 'succeeded', output: { text: JSON.stringify({ data: null, artifactOutputs }), extra: true } } },
    { ...published(), result: native({ data: null, artifactOutputs, callerAuthority: true }) },
    { ...published(), result: { outcome: 'succeeded', output: { text: '```json\n{}\n```' } } },
    { ...published(), result: native({ data: 'x'.repeat(64 * 1024), artifactOutputs }) },
    { ...published(), canonicalReceipts: [] },
  ])('rejects rewritten, mixed, unbounded or caller-authorized carriers %#', value => {
    expect(RemoteWorkflowPhysicalOutputSchema.safeParse(value).success).toBe(false)
  })
  it('supports fresh first import without a root-barrel initialization cycle', () => {
    const url = new URL('../dist/remoteWorkflowPhysical.js', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {RemoteWorkflowPhysicalOutputSchema}=await import(${JSON.stringify(url)}); RemoteWorkflowPhysicalOutputSchema.parse({kind:'text-only',result:{outcome:'succeeded'}})`], { encoding: 'utf8', timeout: 10_000 })
    expect(result.status, result.stderr).toBe(0)
  })
})
