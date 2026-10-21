import type { RunBoardSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { AcceptedRepeatStartV1 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'

/** Admission projection only. Never call this from a history read.
 * Optional layout fields use the Board defaults at this base (graph/mapper.ts):
 * 208 x 112, x = 64 + index * 300, y = 120. Explicit saved sizes are not clamped.
 * These numbers become stored facts, not defaults reapplied by future readers. */
export function projectRunBoardSnapshot(accepted: AcceptedRepeatStartV1): Extract<RunBoardSnapshot, { kind: 'available' }> {
  const { run, snapshot: { executable: { version } } } = accepted
  if (run.workflowVersionId !== version.id || run.workflowId !== version.workflowId
    || run.workspaceId !== version.workspaceId
    || accepted.snapshot.workflow.currentVersionId !== version.id) throw new DomainError(
    'RUN_SNAPSHOT_PIN_CONFLICT', 'The board capture must use the admitted workflow version.', 409)
  // AcceptedRepeatStartV1Schema already proves the locked saved Board has the
  // pinned version's executable meaning. Names/geometry/handles may legitimately
  // have newer saved values without a new version ID; capture THOSE values once.
  // Never use an unrequested draft, nor query this mutable row on history reads.
  const board = accepted.snapshot.workflow.definition
  return {
    kind: 'available', workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, capturedAt: run.createdAt,
    nodes: board.nodes.map((node, index) => {
      const name = node.name ?? node.label
      if (!name) throw new DomainError('RUN_SNAPSHOT_PIN_CONFLICT', 'A saved board node has no name.', 409)
      const presentation = { id: node.id, name,
        position: node.position ? { x: node.position.x, y: node.position.y } : { x: 64 + index * 300, y: 120 },
        size: { width: node.width ?? 208, height: node.height ?? 112 } }
      if (node.kind === 'job') {
        const pinned = version.definition.nodes.find((item) => item.id === node.id)
        if (pinned?.kind !== 'job' || pinned.jobDefinitionId !== node.jobDefinitionId
          || pinned.jobDefinitionRevision !== node.jobDefinitionRevision || pinned.jobDefinitionVersionId !== node.jobDefinitionVersionId) {
          throw new DomainError('RUN_SNAPSHOT_PIN_CONFLICT', 'A board Job node must match its exact admitted definition pin.', 409)
        }
        return { ...presentation, kind: 'job' as const, jobDefinitionId: node.jobDefinitionId,
          jobDefinitionRevision: node.jobDefinitionRevision, jobDefinitionVersionId: node.jobDefinitionVersionId }
      }
      const configurationId = run.agentConfigurationVersionIds[node.agentId]
      if (!configurationId || configurationId !== version.agentConfigurationVersionIds[node.agentId]) throw new DomainError(
        'RUN_SNAPSHOT_PIN_CONFLICT', 'A board node is missing its exact admitted Agent configuration pin.', 409)
      return {
        ...presentation, ...(node.kind === undefined ? {} : { kind: node.kind }),
        agentId: node.agentId, agentConfigurationVersionId: configurationId,
      }
    }),
    // A whitelist, not an object spread: future configuration fields must not leak.
    edges: board.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target, kind: edge.kind,
      ...(edge.sourceHandle === undefined ? {} : { sourceHandle: edge.sourceHandle }),
      ...(edge.targetHandle === undefined ? {} : { targetHandle: edge.targetHandle }),
      ...(edge.label === undefined ? {} : { label: edge.label }),
      ...(edge.maxWorkHandoffsPerRun === undefined ? {} : { maxWorkHandoffsPerRun: edge.maxWorkHandoffsPerRun }),
      ...(edge.workRequestDirection === undefined ? {} : { workRequestDirection: edge.workRequestDirection }),
    })),
  }
}
