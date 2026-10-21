import { expect, it } from 'vitest'
import { RemoteWorkflowPhysicalOutputSchema, remoteWorkflowPhysicalOutput } from './remoteWorkflowPhysical.js'

it('uses the pinned protocol for original physical artifact associations without changing native bytes', () => {
  const artifactOutputs = { version: 1, outputs: [{ outputKey: 'report', commandId: 'original-publication' }] }
  const result = { outcome: 'succeeded' as const, output: { text: JSON.stringify({
    data: { text: 'Complete' }, artifactOutputs, summary: 'Complete.', board: { kind: 'none', reason: 'no_access' },
  }) } }
  const declaration = { version: 1 as const, outputKeys: ['report'] }
  const output = remoteWorkflowPhysicalOutput(result, declaration, undefined, 'f1-f4-v1')
  expect(output).toEqual({ kind: 'published-artifacts', resultProtocol: 'f1-f4-v1', result, artifactOutputs })
  expect(RemoteWorkflowPhysicalOutputSchema.parse(output)).toEqual(output)
  expect(remoteWorkflowPhysicalOutput(result, declaration)).toMatchObject({ kind: 'invalid-artifacts' })
  expect(RemoteWorkflowPhysicalOutputSchema.safeParse({ ...output,
    artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId: 'unrelated-publication' }] },
  }).success).toBe(false)
})
