import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { WorkflowDefinitionV3Schema, WorkflowVersionV3Schema } from './saved.js'
import {
  WorkHandoffResultSchema, WorkHandoffUsageSchema, WorkNoticeSchema, WorkReturnSchema,
  canAdmitWorkHandoff, consumesWorkHandoffSlot, parseWorkHandoffResult, parseWorkHandoffArtifactResult,
  workConnectionForRequest, workLimitNoticeText,
} from './handoffs.js'

const fixture = makeCurrentWorkflowFixture('handoffs-contract')
const [a, b] = fixture.version.definition.nodes
const original = fixture.version.definition.edges[0]!
const c = { id: 'node-c', agentId: 'agent-c', name: 'C' }
const d = { id: 'node-d', agentId: 'agent-d', name: 'D' }
const edge = (id: string, source: string, target: string, cap?: number) => ({
  id, source, target, kind: 'execution' as const,
  ...(cap === undefined ? {} : { maxWorkHandoffsPerRun: cap }),
})
const graph = (edges: unknown[], extra: Record<string, unknown> = {}) => ({
  ...fixture.version.definition, nodes: [a, b, c, d], edges, handoffs: { contractVersion: 1 },
  executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 }, ...extra,
})

describe('FLOW-01 versioned work handoff contract', () => {
  it('preserves exact old ordinary and finite-repeat definitions', () => {
    for (const form of ['sequential', 'repeat'] as const) {
      const old = makeCurrentWorkflowFixture(`old-${form}`, form).version
      expect(WorkflowVersionV3Schema.parse(old)).toEqual(old)
      expect(Object.hasOwn(old.definition, 'handoffs')).toBe(false)
    }
  })

  it('pins a new policy and independent limits on connections that share B', () => {
    const definition = WorkflowDefinitionV3Schema.parse(graph([
      edge('ab', a!.id, b!.id, 2), edge('bc', b!.id, c.id, 3), edge('bd', b!.id, d.id),
    ]))
    expect(definition.handoffs).toEqual({ contractVersion: 1 })
    expect(workConnectionForRequest(definition, b!.id, c.id)?.id).toBe('bc')
    expect(workConnectionForRequest(definition, b!.id, d.id)?.maxWorkHandoffsPerRun).toBeUndefined()
    expect(workConnectionForRequest(definition, c.id, b!.id)).toBeUndefined()
    expect(workConnectionForRequest(definition, a!.id, d.id)).toBeUndefined()
    const scope = fixture.scope
    const bc = { scope, relationshipId: 'bc', used: 0, maxWorkHandoffsPerRun: 3 }
    const ab = { ...bc, relationshipId: 'ab', maxWorkHandoffsPerRun: 2 }
    expect([0, 1, 2, 3].map((used) => canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...bc, used })))).toEqual([true, true, true, false])
    expect(canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...ab, used: 2 }))).toBe(false)
    expect(canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...bc, used: 2 }))).toBe(true)
    expect(canAdmitWorkHandoff(WorkHandoffUsageSchema.parse({ ...bc, used: 10000, maxWorkHandoffsPerRun: null }))).toBe(true)
  })

  it('round trips the new marker and line limit through an immutable saved version', () => {
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      edges: [{ ...original, maxWorkHandoffsPerRun: 3 }],
    } })
    expect(version.definition.handoffs).toEqual({ contractVersion: 1 })
    expect(WorkflowVersionV3Schema.parse(version)).toEqual(version)
    expect(version.definition.edges[0]?.maxWorkHandoffsPerRun).toBe(3)
  })

  it('rejects invalid caps, unmarked limits, approval limits, duplicate directions and block mixing', () => {
    for (const cap of [0, -1, 1.5, '3', null, 2147483648]) {
      expect(WorkflowDefinitionV3Schema.safeParse(graph([edge('bc', b!.id, c.id, cap as number)])).success).toBe(false)
    }
    expect(WorkflowDefinitionV3Schema.safeParse({ ...fixture.version.definition,
      edges: [{ ...original, maxWorkHandoffsPerRun: 3 }] }).success).toBe(false)
    expect(WorkflowDefinitionV3Schema.safeParse(graph([
      { ...edge('bc', b!.id, c.id), kind: 'approval', maxWorkHandoffsPerRun: 3 },
    ])).success).toBe(false)
    expect(WorkflowDefinitionV3Schema.safeParse(graph([
      edge('bc', b!.id, c.id, 3), edge('cb', c.id, b!.id, 3),
    ])).success).toBe(false)
    const oldRepeat = makeCurrentWorkflowFixture('old-repeat-mixed', 'repeat').version.definition
    expect(WorkflowDefinitionV3Schema.safeParse({ ...oldRepeat, handoffs: { contractVersion: 1 } }).success).toBe(false)
  })

  it('allows explicit reverse new work but never creates a second pair allowance', () => {
    const definition = WorkflowDefinitionV3Schema.parse(graph([
      { ...edge('bc', b!.id, c.id, 3), workRequestDirection: 'both' },
    ]))
    expect(workConnectionForRequest(definition, c.id, b!.id)?.id).toBe('bc')
    const reverse = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      edges: [{ ...original, workRequestDirection: 'both', maxWorkHandoffsPerRun: 3 }],
      nodes: [a, { ...b!, choice: { outcomes: [
        { outcome: 'send_back', target: { kind: 'edge', relationshipId: original.id } },
      ] } }],
    } })
    expect(reverse.definition.nodes[1]?.choice?.outcomes[0]?.outcome).toBe('send_back')
  })

  it('supports handoff and declared artifacts in one original native result', () => {
    const declaration = { version: 1 as const, outputKeys: ['report'] }
    const result = { routing: { kind: 'request', outcome: 'review' },
      data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
      artifactOutputs: { version: 1, outputs: [{ outputKey: 'report', commandId: 'original-publication' }] } }
    const native = { outcome: 'succeeded', output: { text: JSON.stringify(result) } }
    expect(parseWorkHandoffResult(native)).toEqual(result)
    expect(parseWorkHandoffArtifactResult(native, declaration)).toEqual(result)
    expect(() => parseWorkHandoffArtifactResult(native, { ...declaration, outputKeys: ['other'] }))
      .toThrow('WORKFLOW_ARTIFACT_OUTPUT_KEYS_MISMATCH')
    expect(() => parseWorkHandoffArtifactResult({ ...native, output: result }, declaration))
      .toThrow('WORKFLOW_ARTIFACT_NATIVE_TEXT_REQUIRED')
    const missing = { routing: result.routing, data: result.data }
    expect(() => parseWorkHandoffArtifactResult({ ...native, output: { text: JSON.stringify(missing) } }, declaration))
      .toThrow()
    expect(WorkHandoffResultSchema.safeParse({ ...result, artifactOutputs: { ...result.artifactOutputs,
      outputs: [{ ...result.artifactOutputs.outputs[0], fileId: 'invented' }] } }).success).toBe(false)
    const version = WorkflowVersionV3Schema.parse({ ...fixture.version, definition: {
      ...fixture.version.definition, handoffs: { contractVersion: 1 },
      nodes: fixture.version.definition.nodes.map((node, index) => index ? node : { ...node, artifactOutputs: declaration }),
    } })
    const savedNode = version.definition.nodes[0]
    expect(savedNode?.kind !== 'job' && savedNode?.artifactOutputs).toEqual(declaration)
  })

  it('charges only a new business work request and requires truthful return and notice shapes', () => {
    expect(['work_request', 'work_return', 'permission_exchange', 'approval_exchange',
      'technical_retry', 'replay', 'progress', 'system_notice', 'delivery_acknowledgement']
      .map((kind) => consumesWorkHandoffSlot(kind as Parameters<typeof consumesWorkHandoffSlot>[0])))
      .toEqual([true, false, false, false, false, false, false, false, false])
    const result = { routing: { kind: 'return', requestId: 'request-3', outcome: 'needs_changes' },
      data: { latestDeliverable: { id: 'artifact-3' }, remainingFindings: [{ id: 'finding-1' }] } }
    expect(WorkHandoffResultSchema.parse(result)).toEqual(result)
    expect(WorkHandoffResultSchema.safeParse({ ...result, routing: { kind: 'finish', outcome: 'done' } }).success).toBe(true)
    expect(parseWorkHandoffResult({ outcome: 'succeeded', output: { text: JSON.stringify(result) } })).toEqual(result)
    expect(() => parseWorkHandoffResult({ outcome: 'succeeded', output: `feedback: ${JSON.stringify(result)}` })).toThrow()
    const withoutId = { ...result, routing: { kind: 'return', outcome: 'needs_changes' } }
    expect(WorkHandoffResultSchema.parse(withoutId)).toEqual(withoutId)
    expect(parseWorkHandoffResult({ outcome: 'succeeded', output: { text: JSON.stringify(withoutId) } }))
      .toEqual(withoutId)
    expect(WorkHandoffResultSchema.safeParse({ ...result, data: { ...result.data, latestDeliverable: 'x'.repeat(65536) } }).success).toBe(false)
    const returned = { scope: fixture.scope, returnId: 'return-3', requestId: 'request-3',
      sourceActivationId: 'activation-c-3', sourceExecutionId: 'execution-c-3', requesterActivationId: 'activation-b-3',
      continuationActivationId: 'activation-b-4',
      acceptedResultDigest: `sha256:${'0'.repeat(64)}`, outcome: 'needs_changes',
      latestDeliverable: result.data.latestDeliverable, remainingFindings: result.data.remainingFindings,
      returnedAt: fixture.createdAt }
    expect(WorkReturnSchema.parse(returned)).toEqual(returned)
    expect(WorkReturnSchema.safeParse({ ...returned, latestDeliverable: null }).success).toBe(false)
    const { continuationActivationId: _unused, ...withoutContinuation } = returned
    expect(WorkReturnSchema.safeParse({ ...withoutContinuation, outcome: 'accepted', remainingFindings: [] }).success).toBe(true)
    expect(WorkReturnSchema.parse({ ...withoutContinuation, outcome: 'accepted' }).remainingFindings)
      .toEqual(result.data.remainingFindings)
    expect(WorkReturnSchema.safeParse({ ...returned, outcome: 'accepted' }).success).toBe(false)
    void _unused
    const notice = { scope: fixture.scope, noticeId: 'notice-3', requesterActivationId: 'activation-b-3',
      cause: { kind: 'last_return', returnId: 'return-3' }, continuationActivationId: 'activation-b-4',
      relationshipId: 'bc', destinationNodeId: 'node-c', destinationAgentId: 'agent-c', destinationName: 'C',
      used: 3, maxWorkHandoffsPerRun: 3,
      latestDeliverable: returned.latestDeliverable, remainingFindings: returned.remainingFindings,
      alternatives: [{ relationshipId: 'bd', destinationNodeId: 'node-d', destinationAgentId: 'agent-d',
        destinationName: 'D', outcomes: ['review_d'], used: 0, maxWorkHandoffsPerRun: null }],
      message: workLimitNoticeText('C', 3, 3), delivery: 'pending',
      createdAt: fixture.createdAt, updatedAt: fixture.createdAt }
    expect(WorkNoticeSchema.parse(notice)).toEqual(notice)
    expect(WorkNoticeSchema.safeParse({ ...notice, message: 'The limit is reached.' }).success).toBe(false)
    expect(WorkNoticeSchema.safeParse({ ...notice, delivery: 'delivered' }).success).toBe(false)
    expect(WorkNoticeSchema.safeParse({ ...notice, delivery: 'delivered', acknowledgementId: 'ack-3' }).success).toBe(true)
  })
})
