import assert from 'node:assert/strict'
import type { GraphDraftV3, WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { authoringHints, changeApprovalHandler, draftOperations, entryChoices, hasLocalChanges,
  mergeAcknowledgement, putRelationship, relationshipPairs, removeNode, removeRelationship, roleEvidence, sameValue,
  type NextDraftContext } from './model'
import { createNextDraftSlice, editNextDraft, newNextDraft, nextDraftDirty, nextDraftKey, undoNextDraft,
  type DraftRequest, type NextDraftEdit, type NextDraftSlice } from './state'
import { createNextDraftWriter, draftFailure } from './writer'
import type { NextDraftApi } from './transport'
import { deferred } from '../../../test/deferred'

export function fixture(roles: ('coder' | 'orchestrator')[] = ['coder', 'coder']): NextDraftContext {
  const graph: WorkflowDefinitionV3 = {
    id: 'workflow', workspaceId: 'workspace', name: 'Authoring fixture', executionSemanticsVersion: 3,
    entryNodeId: 'node-0', executionCondition: { kind: 'manual' }, approval: { handler: 'user' },
    executionPolicy: { maxParallelism: 4, maxNodeExecutions: 1000 }, version: 1,
    nodes: roles.map((_, index) => ({ id: `node-${index}`, agentId: `agent-${index}`, name: `Node ${index}`, position: { x: index * 250, y: 0 } })),
    edges: roles.slice(1).map((_, index) => ({ id: `execution-${index + 1}`, source: 'node-0', target: `node-${index + 1}`, kind: 'execution' })),
  }
  return { draft: { id: 'draft', workspaceId: 'workspace', workflowId: 'workflow', revision: 7, publishedRevision: 7,
    baseWorkflowVersionId: 'workflow-version-1', graph, stagedAgents: [], updatedByPrincipalId: 'user-fixture', updatedAt: '2026-09-22T00:00:00Z' },
  agents: roles.map((productRole, index) => ({ metadataRevision: 3, agent: { id: `agent-${index}`, name: `Agent ${index}`,
    productRole, configurationVersionId: `configuration-${index}` } })) }
}
const clone = <T>(value: T): T => structuredClone(value)
const graphWith = (context: NextDraftContext, update: Partial<WorkflowDefinitionV3>) => ({ ...context.draft.graph, ...update })
const issue = (graph: WorkflowDefinitionV3, context: NextDraftContext, code: string) => authoringHints(graph, context).some((item) => item.code === code)

/** Synthetic authoring transport only; not a PostgreSQL, authentication, or native fixture. */
function harness(context = fixture()) {
  let edit: NextDraftEdit | undefined = newNextDraft(context, 'instance')
  let server = clone(context.draft)
  const calls: DraftRequest[] = []
  const committed = new Map<string, { draft: GraphDraftV3; agents: undefined }>()
  const write: NextDraftApi['write'] = async (request) => {
    calls.push(clone(request))
    const replay = committed.get(request.commandId)
    if (replay) return clone(replay)
    assert.equal(request.expectedRevision, server.revision)
    let graph = server.graph
    for (const op of request.operations ?? []) {
      switch (op.type) {
        case 'workflow.set_entry': graph = { ...graph, entryNodeId: op.entryNodeId }; break
        case 'node.set_choice': graph = { ...graph, nodes: graph.nodes.map((node) => {
          if (node.id !== op.nodeId) return node
          const next = { ...node }; if (op.choice) next.choice = op.choice; else delete next.choice; return next
        }) }; break
        case 'node.replace_v3': graph = { ...graph, nodes: graph.nodes.map((node) => node.id === op.node.id ? op.node : node) }; break
        case 'node.remove': graph = removeNode(graph, op.nodeId); break
        case 'relationship.put': graph = putRelationship(graph, op.relationship); break
        case 'edge.disconnect': graph = removeRelationship(graph, op.edgeId); break
        case 'nodes.reorder': graph = { ...graph, nodes: op.nodeIds.map((id) => graph.nodes.find((node) => node.id === id)!) }; break
        case 'edges.reorder': graph = { ...graph, edges: op.edgeIds.map((id) => graph.edges.find((edge) => edge.id === id)!) }; break
        case 'workflow.set_approval': graph = { ...graph, approval: op.approval }; break
        case 'workflow.set_execution_limits':
          graph = { ...graph, executionPolicy: {
            maxParallelism: op.maxParallelism,
            maxNodeExecutions: op.maxNodeExecutions,
            ...(op.agentActiveTimeoutMs === undefined ? {} : { agentActiveTimeoutMs: op.agentActiveTimeoutMs }),
          } }
          break
        default: throw new Error(`Unsupported synthetic fixture operation ${op.type}`)
      }
    }
    server = { ...server, graph: clone(graph), revision: server.revision + 1 }
    if (request.kind === 'save') server = { ...server, publishedRevision: server.revision, baseWorkflowVersionId: `version-${server.revision}` }
    const result = { draft: clone(server), agents: undefined }
    committed.set(request.commandId, result)
    return result
  }
  const api: NextDraftApi = { write, layoutBase: async () => ({ draft: server, expectedAgentConfigurationVersionIds: {} }), pins: async () => ({ expectedAgentConfigurationVersionIds: {}, agents: context.agents }), discardLocal: () => { throw new Error('Authoring fixture does not discard local transport state') }, open: async () => server, get: async () => server,
    acceptContext: (fresh) => { server = clone(fresh.draft) },
    context: async () => ({ draft: server, agents: context.agents }), validate: async () => ({ valid: true, issues: [] }),
    editRead: async () => { throw new Error('Authoring fixture does not read edit intents') },
    editStage: async () => { throw new Error('Authoring fixture does not stage edit intents') },
    editAdvance: async () => { throw new Error('Authoring fixture does not advance edit intents') },
    editDiscard: async () => { throw new Error('Authoring fixture does not discard edit intents') },
    runs: async () => ({ items: [], pageInfo: { nextCursor: null } }) }
  const access = { get: () => edit, update: (_: string, update: (edit: NextDraftEdit) => NextDraftEdit) => { if (edit) edit = update(edit) } }
  let sequence = 0
  return { api, calls, committed, access, edit: () => edit!, server: () => server,
    change: (update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3) => { edit = editNextDraft(edit!, update) },
    replace: (next: NextDraftEdit | undefined) => { edit = next },
    writer: (validate: (graph: WorkflowDefinitionV3, operations: unknown[]) => void = () => undefined, session?: () => () => void) =>
      createNextDraftWriter(api, access, validate, () => `command-${++sequence}`, session) }
}
const rename = (graph: WorkflowDefinitionV3, name = 'Edited node') => ({ ...graph, nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, name } : node) })
export const coreCases: { name: string; run: () => void | Promise<void> }[] = [
  { name: 'saving and clearing the Agent active-time budget survives draft acknowledgements', async run() {
    const h = harness()
    h.change((graph) => ({ ...graph, executionPolicy: {
      ...graph.executionPolicy!, agentActiveTimeoutMs: 3_600_000,
    } }))
    await h.writer().write('key', true)
    assert.equal(h.server().graph.executionPolicy?.agentActiveTimeoutMs, 3_600_000)
    assert.equal(h.edit().graph.executionPolicy?.agentActiveTimeoutMs, 3_600_000)
    assert.equal(nextDraftDirty(h.edit()), false)
    h.change((graph) => {
      const executionPolicy = { ...graph.executionPolicy! }
      delete executionPolicy.agentActiveTimeoutMs
      return { ...graph, executionPolicy }
    })
    await h.writer().write('key', true)
    assert.equal(Object.hasOwn(h.server().graph.executionPolicy!, 'agentActiveTimeoutMs'), false)
    assert.equal(Object.hasOwn(h.edit().graph.executionPolicy!, 'agentActiveTimeoutMs'), false)
    assert.equal(h.server().graph.executionPolicy?.maxParallelism, 4)
    assert.equal(h.server().graph.executionPolicy?.maxNodeExecutions, 1000)
    assert.equal(nextDraftDirty(h.edit()), false)
  } },
  { name: 'draft keys cannot collide across opaque workspace or workflow separators', run() { assert.notEqual(nextDraftKey('a::b', 'c'), nextDraftKey('a', 'b::c')); assert.notEqual(nextDraftKey('a', 'b:c'), nextDraftKey('a:b', 'c')) } },
  { name: 'sole Worker explicitly starts itself', run() { const c = fixture(['coder']); assert.equal(entryChoices(c.draft.graph, c).valid, true); assert.equal(entryChoices(c.draft.graph, c).mode, 'sole') } },
  { name: 'sole Orchestrator explicitly starts itself', run() { const c = fixture(['orchestrator']); assert.equal(entryChoices(c.draft.graph, c).valid, true) } },
  { name: 'no Orchestrator permits selecting either Worker', run() { const c = fixture(); assert.equal(entryChoices(c.draft.graph, c).eligible.length, 2) } },
  { name: 'one Orchestrator excludes Worker entry', run() { const c = fixture(['coder', 'orchestrator']); assert.equal(entryChoices(c.draft.graph, c).valid, false); assert.deepEqual(entryChoices(c.draft.graph, c).eligible.map((n) => n.id), ['node-1']) } },
  { name: 'multiple Orchestrators require one explicit node selection', run() { const c = fixture(['orchestrator', 'orchestrator', 'coder']); assert.equal(entryChoices(c.draft.graph, c).eligible.length, 2); assert.equal(entryChoices(graphWith(c, { entryNodeId: null }), c).valid, false) } },
  { name: 'labels and free role text cannot create an Orchestrator', run() { const c = fixture(); c.agents[1]!.agent.role = 'Orchestrator'; c.draft.graph.nodes[1]!.name = 'Orchestrator'; assert.equal(entryChoices(c.draft.graph, c).mode, 'worker') } },
  { name: 'unknown product-role pins disable Worker fallback', run() { const c = fixture(); delete c.agents[1]!.agent.productRole; assert.equal(entryChoices(c.draft.graph, c).eligible.length, 0); assert(issue(c.draft.graph, c, 'ROLE_PIN_UNAVAILABLE')) } },
  { name: 'changed source configuration is unavailable until explicit reload', run() { const c = fixture(); c.draft.sourceAgentPins = [{ agentId: 'agent-0', metadataRevision: 3, configurationVersionId: 'older-pin' }]; assert.equal(roleEvidence(c, 'agent-0').source, 'unavailable') } },
  { name: 'explicit staged role edits use the proposed role without rewriting the saved configuration pin', run() { const c = fixture(); const edits = { 'agent-0': { ...c.agents[0]!.agent, productRole: 'orchestrator' as const } }; assert.equal(roleEvidence(c, 'agent-0', edits).source, 'staged'); assert.equal(entryChoices(c.draft.graph, c, edits).mode, 'orchestrator'); assert.equal(c.agents[0]!.agent.productRole, 'coder'); assert.equal(c.agents[0]!.agent.configurationVersionId, 'configuration-0') } },
  { name: 'reorder and geometry never alter the entry pin', run() { const c = fixture(); const g = graphWith(c, { nodes: [...c.draft.graph.nodes].reverse().map((n) => ({ ...n, position: { x: 700, y: 900 } })) }); assert.equal(g.entryNodeId, 'node-0'); assert(!draftOperations(c, g).some((o) => o.type === 'workflow.set_entry')) } },
  { name: 'deleting entry clears it rather than selecting another node', run() { const c = fixture(); const g = removeNode(c.draft.graph, 'node-0'); assert.equal(g.entryNodeId, null); assert(issue(g, c, 'ENTRY_REQUIRED')) } },
  { name: 'deleting a non-entry leaves entry and unrelated references unchanged', run() { const c = fixture(['coder', 'coder', 'coder']); const g = removeNode(c.draft.graph, 'node-1'); assert.equal(g.entryNodeId, 'node-0'); assert.equal(g.nodes[0], c.draft.graph.nodes[0]); assert.equal(g.edges.length, 1) } },
  { name: 'role change causes correction without silently changing entry', run() { const c = fixture(); c.agents[1]!.agent.productRole = 'orchestrator'; assert(issue(c.draft.graph, c, 'ENTRY_REQUIRED')); assert.equal(c.draft.graph.entryNodeId, 'node-0') } },
  { name: 'incoming execution dependency blocks entry but approval does not', run() { const c = fixture(); const g = putRelationship(c.draft.graph, { id: 'back', source: 'node-1', target: 'node-0', kind: 'execution' }); assert(issue(g, c, 'ENTRY_HAS_DEPENDENCY')); assert(!issue({ ...g, edges: g.edges.map((e) => e.id === 'back' ? { ...e, kind: 'approval' } : e) }, c, 'ENTRY_HAS_DEPENDENCY')) } },
  { name: 'paired execution and approval retain both IDs and directions', run() { const c = fixture(); const g = putRelationship(c.draft.graph, { id: 'review', source: 'node-1', target: 'node-0', kind: 'approval' }); assert.equal(relationshipPairs(g).length, 1); assert.deepEqual(relationshipPairs(g)[0]!.map((r) => [r.id, r.kind, r.source, r.target]), [['execution-1', 'execution', 'node-0', 'node-1'], ['review', 'approval', 'node-1', 'node-0']]) } },
  { name: 'removing one semantic record never removes its paired work route', run() { const c = fixture(); const g = putRelationship(c.draft.graph, { id: 'review', source: 'node-0', target: 'node-1', kind: 'approval' }); const removed = removeRelationship(g, 'review'); assert.deepEqual(removed.edges, c.draft.graph.edges); assert.equal(removed.edges[0], c.draft.graph.edges[0]) } },
  { name: 'a relationship ID cannot change kinds in UI or diff', run() { const c = fixture(); const replacement = { ...c.draft.graph.edges[0]!, kind: 'approval' as const }; assert.throws(() => putRelationship(c.draft.graph, replacement)); assert.throws(() => draftOperations(c, { ...c.draft.graph, edges: [replacement] })) } },
  { name: 'second reviewer is not substituted silently', run() { const c = fixture(['orchestrator', 'coder', 'orchestrator']); const g = putRelationship(c.draft.graph, { id: 'one', source: 'node-0', target: 'node-1', kind: 'approval' }); assert.throws(() => putRelationship(g, { id: 'two', source: 'node-2', target: 'node-1', kind: 'approval' })) } },
  { name: 'authority switch requires explicit approval deletion, never work-route deletion', run() { const c = fixture(); const g = putRelationship(c.draft.graph, { id: 'review', source: 'node-0', target: 'node-1', kind: 'approval' }); assert.throws(() => changeApprovalHandler(g, 'user')); const result = changeApprovalHandler(removeRelationship(g, 'review'), 'user'); assert.equal(result.edges[0]!.kind, 'execution'); assert.equal(result.approval!.handler, 'user') } },
  { name: 'unsupported independent reviewer assignments remain explanatory draft errors', run() { const c = fixture(['orchestrator', 'coder', 'orchestrator']); let g = changeApprovalHandler(c.draft.graph, 'orchestrator'); g.approval = { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-0' }; g = putRelationship(g, { id: 'review', source: 'node-2', target: 'node-1', kind: 'approval' }); assert(issue(g, c, 'REVIEWER_BOOTSTRAP_UNSUPPORTED')) } },
  { name: 'empty outcome declaration remains incomplete, never default fan-out', run() { const c = fixture(); const g = clone(c.draft.graph); g.nodes[0]!.choice = { outcomes: [] }; assert(issue(g, c, 'CHOICE_INCOMPLETE')); assert(g.nodes[0]!.choice) } },
  { name: 'duplicate and invalid outcome names have actionable hints', run() { const c = fixture(); const g = clone(c.draft.graph); g.nodes[0]!.choice = { outcomes: [{ outcome: 'bad prose', target: { kind: 'branch_end' } }, { outcome: 'bad prose', target: { kind: 'branch_end' } }] }; assert(issue(g, c, 'OUTCOME_INVALID')) } },
  { name: 'explicit branch end is retained as its own target', run() { const c = fixture(['coder']); const g = clone(c.draft.graph); g.nodes[0]!.choice = { outcomes: [{ outcome: 'finished', target: { kind: 'branch_end' } }] }; assert(!issue(g, c, 'CHOICE_TARGET_REQUIRED')); assert.deepEqual(draftOperations(c, g), [{ type: 'node.set_choice', nodeId: 'node-0', choice: g.nodes[0]!.choice }]) } },
  { name: 'deleting a selected choice edge retains a visibly missing reference', run() { const c = fixture(); const g = clone(c.draft.graph); g.nodes[0]!.choice = { outcomes: [{ outcome: 'next', target: { kind: 'edge', relationshipId: 'execution-1' } }] }; const result = removeRelationship(g, 'execution-1'); assert(issue(result, c, 'CHOICE_TARGET_REQUIRED')); assert.equal(result.nodes[0]!.choice!.outcomes[0]!.target.kind, 'edge') } },
  { name: 'approval record cannot be used as a routing target', run() { const c = fixture(); const g = putRelationship(c.draft.graph, { id: 'review', source: 'node-0', target: 'node-1', kind: 'approval' }); g.nodes = g.nodes.map((n) => n.id === 'node-0' ? { ...n, choice: { outcomes: [{ outcome: 'ok', target: { kind: 'edge', relationshipId: 'review' } }] } } : n); assert(issue(g, c, 'CHOICE_TARGET_REQUIRED')) } },
  { name: 'ordinary fan-out removal of choice emits explicit null', run() { const c = fixture(); c.draft.graph.nodes[0]!.choice = { outcomes: [{ outcome: 'ok', target: { kind: 'edge', relationshipId: 'execution-1' } }] }; const g = clone(c.draft.graph); delete g.nodes[0]!.choice; assert.deepEqual(draftOperations(c, g), [{ type: 'node.set_choice', nodeId: 'node-0', choice: null }]) } },
  { name: 'undo content cannot rewind acknowledged revision or configuration pins', run() { const c = fixture(); let e = editNextDraft(newNextDraft(c, 'i'), rename); e = { ...e, context: { ...e.context, draft: { ...e.context.draft, revision: 19 } } }; const result = undoNextDraft(e); assert.equal(result.context.draft.revision, 19); assert.equal(result.context.agents[0]!.agent.configurationVersionId, 'configuration-0'); assert.equal(result.graph.nodes[0]!.name, 'Node 0') } },
  { name: 'failed form edits and exact pending command survive further typing', run() { const c = fixture(); const pending: DraftRequest = { kind: 'save', commandId: 'retained', workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', expectedRevision: 7, executionSemanticsVersion: 3 }; let e = newNextDraft(c, 'i'); e = { ...e, pending, error: { code: 'NETWORK_ERROR', message: 'uncertain', uncertain: true } }; e = editNextDraft(e, rename); assert.equal(e.pending, pending); assert.equal(e.error!.uncertain, true); assert(nextDraftDirty(e)) } },
  { name: 'own acknowledgement preserves newer input and unchanged entity references', run() { const c = fixture(); const sent = rename(c.draft.graph, 'sent'), saved = { ...sent, version: 2 }, current = rename(sent, 'new typing'); const result = mergeAcknowledgement(current, sent, saved); assert.equal(result.nodes[0]!.name, 'new typing'); assert.equal(result.nodes[1], current.nodes[1]); assert.equal(result.version, 2) } },
  { name: 'metadata timestamps alone are not authored dirtiness', run() { const c = fixture(); assert(!hasLocalChanges(c, { ...c.draft.graph, updatedAt: '2026-09-22T00:01:00Z' })); assert(sameValue({ a: undefined, b: 2 }, { b: 2 })) } },
  { name: 'safe slice install/remount retains unsaved form and cannot drop uncertain work', run() { let state: NextDraftSlice; const set = (update: (s: NextDraftSlice) => Partial<NextDraftSlice>) => { state = { ...state, ...update(state) } }; state = createNextDraftSlice(set); state.installNextDraft('key', fixture()); state.changeNextDraft('key', rename); const before = state.nextDrafts.key; state.installNextDraft('key', fixture()); assert.equal(state.nextDrafts.key, before); state.updateNextDraft('key', (e) => ({ ...e, busy: true })); state.dropNextDraft('key'); assert(state.nextDrafts.key) } },
  { name: 'one serial owner shares concurrent save clicks', async run() { const h = harness(), done = deferred<void>(); const original = h.api.write; h.api.write = async (request) => { await done.promise; return original(request) }; h.change(rename); const w = h.writer(), a = w.write('key', true), b = w.write('key', true); assert.equal(a, b); done.resolve(); await a; assert.equal(h.calls.length, 2); assert.equal(h.edit().busy, false); assert(!nextDraftDirty(h.edit())) } },
  { name: 'newer edits during save are not visually overwritten', async run() { const h = harness(), done = deferred<void>(); const original = h.api.write; h.api.write = async (request) => { await done.promise; return original(request) }; h.change((g) => rename(g, 'submitted')); const pending = h.writer().write('key', true); h.change((g) => rename(g, 'newer')); done.resolve(); const result = await pending; assert(result.published && result.newerLocalEdits); assert.equal(h.edit().graph.nodes[0]!.name, 'newer'); assert.equal(h.server().graph.nodes[0]!.name, 'submitted') } },
  { name: '403 permission denial never clears the form or retries with broader credentials', async run() { const h = harness(); let calls = 0; h.api.write = async () => { calls++; throw Object.assign(new Error('Denied'), { code: 'FORBIDDEN', status: 403 }) }; h.change(rename); await assert.rejects(h.writer().write('key', true)); assert.equal(calls, 1); assert.equal(h.edit().graph.nodes[0]!.name, 'Edited node'); assert.equal(h.edit().error!.code, 'FORBIDDEN'); assert.equal(h.edit().pending, undefined) } },
  { name: 'stale draft revision preserves form and reports conflict', async run() { const h = harness(); h.api.write = async () => { throw Object.assign(new Error('Draft changed'), { code: 'REVISION_CONFLICT', status: 409 }) }; h.change(rename); await assert.rejects(h.writer().write('key', true)); assert.equal(h.edit().context.draft.revision, 7); assert.equal(h.edit().graph.nodes[0]!.name, 'Edited node'); assert.equal(h.edit().error!.uncertain, false) } },
  { name: 'lost acknowledgement reconciles the exact command without duplicating effects', async run() { const h = harness(), original = h.api.write; let lost = false; h.api.write = async (request) => { const result = await original(request); if (!lost) { lost = true; throw Object.assign(new Error('Connection lost'), { status: 0, code: 'NETWORK_ERROR' }) } return result }; h.change(rename); const writer = h.writer(); await assert.rejects(writer.write('key', true)); const command = clone(h.edit().pending); h.change((g) => rename(g, 'newer')); await writer.write('key', true); assert.deepEqual(h.calls[0], h.calls[1]); assert.equal(h.calls[0]!.commandId, command!.commandId); assert.equal(h.committed.size, 2); assert.equal(h.edit().graph.nodes[0]!.name, 'newer') } },
  { name: 'retry of persist-only command does not silently publish newer intent', async run() { const h = harness(), original = h.api.write; let first = true; h.api.write = async (request) => { if (first) { first = false; throw new Error('Network failed') } return original(request) }; h.change(rename); const writer = h.writer(); await assert.rejects(writer.write('key', false)); const result = await writer.write('key', true); assert.equal(result.published, false); assert.equal(h.calls.some((call) => call.kind === 'save'), false) } },
  { name: 'batch limit is 100 and intermediate acknowledgement cannot erase unapplied edits', async run() { const c = fixture(Array.from({ length: 130 }, () => 'coder' as const)); const h = harness(c), done = deferred<void>(), seen = deferred<void>(); const original = h.api.write; let calls = 0; h.api.write = async (request) => { calls++; if (calls === 2) { seen.resolve(); await done.promise } return original(request) }; h.change((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, name: `Edited ${n.id}` })) })); const saving = h.writer().write('key', true); await seen.promise; assert.equal(h.edit().context.draft.revision, 8); assert.equal(h.edit().graph.nodes[129]!.name, 'Edited node-129'); done.resolve(); await saving; assert.deepEqual(h.calls.map((c) => c.operations?.length ?? 0), [100, 30, 0]); assert.equal(h.edit().context.draft.revision, 10) } },
  { name: 'failed second batch retains earlier base acknowledgement and full local intent', async run() { const h = harness(fixture(Array.from({ length: 101 }, () => 'coder' as const))), original = h.api.write; let count = 0; h.api.write = async (request) => { if (++count === 2) throw Object.assign(new Error('Conflict'), { code: 'REVISION_CONFLICT', status: 409 }); return original(request) }; h.change((g) => ({ ...g, nodes: g.nodes.map((n) => ({ ...n, name: 'changed' })) })); await assert.rejects(h.writer().write('key', true)); assert.equal(h.edit().context.draft.revision, 8); assert.equal(h.edit().graph.nodes[100]!.name, 'changed'); assert.equal(draftOperations(h.edit().context, h.edit().graph).length, 1) } },
  { name: 'late completion cannot resurrect a cleared session draft', async run() { const h = harness(), done = deferred<void>(), original = h.api.write; h.api.write = async (request) => { await done.promise; return original(request) }; h.change(rename); const saving = h.writer().write('key', true); await Promise.resolve(); h.replace(undefined); done.resolve(); await assert.rejects(saving); assert.equal(h.access.get(), undefined) } },
  { name: 'late acknowledgement cannot overwrite a new editor instance', async run() { const h = harness(), done = deferred<void>(), original = h.api.write; h.api.write = async (request) => { await done.promise; return original(request) }; h.change(rename); const saving = h.writer().write('key', true); await Promise.resolve(); const fresh = newNextDraft(fixture(), 'replacement'); h.replace(fresh); done.resolve(); await assert.rejects(saving); assert.equal(h.edit(), fresh) } },
  { name: 'changed session fences acknowledgements before applying them', async run() { const h = harness(), done = deferred<void>(), original = h.api.write; let valid = true; h.api.write = async (request) => { await done.promise; return original(request) }; h.change(rename); const saving = h.writer(undefined, () => () => { if (!valid) throw new Error('Session changed') }).write('key', true); await Promise.resolve(); valid = false; done.resolve(); await assert.rejects(saving); assert.equal(h.edit().context.draft.revision, 7) } },
  { name: 'validation readback cannot claim a later revision is validated', async run() { const h = harness(); h.api.get = async () => ({ ...h.server(), revision: h.server().revision + 1 }); h.change(rename); await h.writer().write('key', false); assert.equal(h.edit().validation, undefined); assert.equal(h.edit().error!.code, 'REVISION_CONFLICT') } },
  { name: 'schema rejection sends no network command and retains invalid input', async run() { const h = harness(); h.change(rename); await assert.rejects(h.writer(() => { throw new Error('Invalid choice') }).write('key', true)); assert.equal(h.calls.length, 0); assert.equal(h.edit().graph.nodes[0]!.name, 'Edited node') } },
  { name: 'uncertain response vs definitive server validation have separate handling', run() { assert(draftFailure(Object.assign(new Error('bad reply'), { code: 'INVALID_RESPONSE', status: 200 }), true).uncertain); assert(!draftFailure(Object.assign(new Error('invalid'), { code: 'GRAPH_INVALID', status: 409 }), true).uncertain) } },
]
