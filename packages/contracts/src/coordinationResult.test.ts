import { describe, expect, it } from 'vitest';
import { COORDINATION_RESULT_PROTOCOL, CoordinationResultSchema, ResultProtocolSchema,
  parseCoordinationResult, type CoordinationResultContext } from './coordinationResult.js';
import { WorkflowDefinitionV3Schema, type WorkflowDefinitionV3 } from './wave25/workflowShape.js';

const board = { kind: 'none', reason: 'no_changes' } as const;
const envelope = { data: { answer: 'complete' }, summary: 'Completed the requested work.', board };
const outputSchema = { type: 'object', required: ['answer'], additionalProperties: false,
  properties: { answer: { type: 'string', minLength: 1 } } };
const choice = { outcomes: [{ outcome: 'done', target: { kind: 'branch_end' } }] };

function context(node: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): CoordinationResultContext {
  return { resultProtocol: COORDINATION_RESULT_PROTOCOL, workflowNodeId: 'worker',
    definition: WorkflowDefinitionV3Schema.parse({ id: 'workflow', workspaceId: 'workspace', name: 'Saved workflow',
      executionSemanticsVersion: 3, entryNodeId: 'worker', executionCondition: { kind: 'manual' },
      nodes: [{ id: 'worker', agentId: 'agent', name: 'Worker', ...node }], edges: [], ...extra }) };
}
const nativeText = (value: unknown) => ({ text: JSON.stringify(value) });

describe('saved-node coordination result parsing', () => {
  it('requires the new marker and complete strict result envelope without changing business data', () => {
    expect(ResultProtocolSchema.safeParse(undefined).success).toBe(false);
    expect(ResultProtocolSchema.safeParse('next').success).toBe(false);
    expect(parseCoordinationResult(nativeText(envelope), context({ outputSchema }))).toEqual(envelope);
    expect(() => parseCoordinationResult({ ...envelope, data: { summary: 'not business data' } }, context({ outputSchema }))).toThrow();
    expect(() => parseCoordinationResult({ data: envelope.data }, context())).toThrow();
    expect(() => parseCoordinationResult({ ...envelope, actor: 'caller-chosen' }, context())).toThrow();
    expect(() => parseCoordinationResult({ ...envelope, data: '  ' }, context())).toThrow();
  });

  it('selects declared choice outcomes and only checks ordinary choice data when a schema exists', () => {
    for (const data of [null, '  ']) expect(parseCoordinationResult({ ...envelope, data,
      routing: { outcome: 'done' } }, context({ choice })).data).toEqual(data);
    expect(() => parseCoordinationResult({ ...envelope, routing: { outcome: 'missing' } }, context({ choice }))).toThrow();
    expect(parseCoordinationResult({ ...envelope, routing: { outcome: 'done' } }, context({ choice, outputSchema }))).toMatchObject(envelope);
    expect(() => parseCoordinationResult({ ...envelope, data: null, routing: { outcome: 'done' } }, context({ choice, outputSchema }))).toThrow();
  });

  it('keeps artifact text carriers and exact saved output keys, including choice artifacts', () => {
    const artifactOutputs = { version: 1, outputs: [{ outputKey: 'report', commandId: 'publish-report' }] };
    const node = { artifactOutputs: { version: 1, outputKeys: ['report'] } };
    const result = { ...envelope, data: null, artifactOutputs };
    expect(parseCoordinationResult(nativeText(result), context(node))).toEqual(result);
    expect(() => parseCoordinationResult(result, context(node))).toThrow('WORKFLOW_ARTIFACT_NATIVE_TEXT_REQUIRED');
    expect(() => parseCoordinationResult({ ...nativeText(result), messages: [] }, context(node))).toThrow();
    expect(() => parseCoordinationResult(nativeText({ ...result, artifactOutputs: { version: 1,
      outputs: [{ outputKey: 'other', commandId: 'publish-other' }] } }), context(node))).toThrow();
    expect(parseCoordinationResult(nativeText({ ...result, routing: { outcome: 'done' } }),
      context({ ...node, choice }))).toMatchObject({ data: null, routing: { outcome: 'done' } });
    expect(() => parseCoordinationResult(nativeText(result), context({ ...node, outputSchema }))).toThrow();
  });

  it('uses a plain interval envelope without applying the normal business output schema or routing', () => {
    const interval = { ...context({ choice, outputSchema, interval: { everySeconds: 30 } }), interval: true };
    const result = { ...envelope, data: 'No change is needed.' };
    expect(parseCoordinationResult(nativeText(result), interval)).toEqual(result);
    expect(() => parseCoordinationResult({ ...result, routing: { outcome: 'done' } }, interval)).toThrow();
  });

  it('requires repeat exit data and checks only latestDeliverable against the saved schema', () => {
    const repeatChoice = { outcomes: [
      { outcome: 'again', target: { kind: 'branch_end' } }, { outcome: 'done', target: { kind: 'branch_end' } },
    ] };
    const repeat = { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: ['worker'], entryNodeId: 'worker',
      exitNodeId: 'worker', maxOccurrences: 3, repeatOutcome: 'again', earlyExitOutcome: 'done', limitExit: { kind: 'branch_end' } }] };
    const selected = context({ choice: repeatChoice, outputSchema }, { repeat });
    const result = { ...envelope, routing: { outcome: 'done' },
      data: { latestDeliverable: envelope.data, remainingFindings: [] } };
    expect(parseCoordinationResult(result, selected)).toEqual(result);
    expect(() => parseCoordinationResult({ ...result, data: envelope.data }, selected)).toThrow();
    expect(() => parseCoordinationResult({ ...result, data: { latestDeliverable: { wrong: true }, remainingFindings: [] } }, selected)).toThrow();
    expect(() => parseCoordinationResult({ ...result, data: { latestDeliverable: '  ', remainingFindings: [] } },
      context({ choice: repeatChoice }, { repeat }))).toThrow();
  });

  it('checks handoff deliverables without a schema and preserves named request routing', () => {
    const selected = context({ choice: { outcomes: [{ outcome: 'review', target: { kind: 'edge', relationshipId: 'edge' } }] } },
      { handoffs: { contractVersion: 1 } });
    const result = { ...envelope, routing: { kind: 'request', outcome: 'review' },
      data: { latestDeliverable: envelope.data, remainingFindings: [] } };
    expect(parseCoordinationResult(result, selected)).toEqual(result);
    expect(() => parseCoordinationResult({ ...result, routing: { kind: 'request', outcome: 'unknown' } }, selected)).toThrow();
    expect(() => parseCoordinationResult({ ...result, data: { latestDeliverable: ' ', remainingFindings: [] } }, selected)).toThrow();
  });

  it('resolves delegation against saved direct children and refuses unresolved Master finish', () => {
    const definition: WorkflowDefinitionV3 = WorkflowDefinitionV3Schema.parse({
      ...context().definition, entryNodeId: 'master', handoffs: { contractVersion: 1 },
      hierarchy: { version: 1, masterNodeId: 'master', parents: [
        { workflowNodeId: 'coordinator', parentNodeId: 'master' }, { workflowNodeId: 'worker', parentNodeId: 'coordinator' },
      ] },
      nodes: [{ id: 'master', agentId: 'master-agent', name: 'Master', choice: { outcomes: [
        { outcome: 'coordinate', target: { kind: 'edge', relationshipId: 'master-edge' } },
        { outcome: 'skip_level', target: { kind: 'edge', relationshipId: 'worker-edge' } },
      ] } }, { id: 'coordinator', agentId: 'coordinator-agent', name: 'Orchestrator' },
      { id: 'worker', agentId: 'worker-agent', name: 'Worker' }],
      edges: [{ id: 'master-edge', source: 'master', target: 'coordinator', kind: 'execution' },
        { id: 'worker-edge', source: 'master', target: 'worker', kind: 'execution' }],
    });
    const selected = { ...context(), definition, workflowNodeId: 'master' };
    const data = { latestDeliverable: envelope.data, remainingFindings: [] };
    const result = { ...envelope, data, routing: { kind: 'delegate', requests: [{ outcome: 'coordinate', data: { task: 'Review' } }] } };
    expect(parseCoordinationResult(result, selected)).toEqual(result);
    expect(() => parseCoordinationResult({ ...result, routing: { kind: 'delegate', requests: [{ outcome: 'skip_level', data: {} }] } }, selected)).toThrow();
    const finish = { ...envelope, data, routing: { kind: 'finish' } };
    expect(parseCoordinationResult(finish, selected)).toEqual(finish);
    expect(() => parseCoordinationResult(finish, { ...selected, outstandingRequestIds: ['request'] })).toThrow('HIERARCHY_WORK_UNRESOLVED');
    expect(() => parseCoordinationResult({ ...finish, data: { ...data, remainingFindings: ['Unresolved'] } }, selected)).toThrow();
  });

  it('bounds serialized output and rejects caller extension fields in domain envelopes', () => {
    const oversized = { ...envelope, data: 'x'.repeat(64 * 1024) };
    expect(CoordinationResultSchema.safeParse(oversized).success).toBe(false);
    expect(() => parseCoordinationResult(nativeText(oversized), context())).toThrow();
    expect(CoordinationResultSchema.safeParse({ ...envelope, board: { ...board, ignored: true } }).success).toBe(false);
  });
});
