import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type Agent } from '@foreman-code/contracts'
import { CurrentWorkflowReadResultSchema, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { apiClient } from '../../shared/api/client'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftDirty } from '../graph/nextDraft/state'
import { readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { graphEditIntentKey } from '../graph/nextDraft/useGraphEditIntent'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'
import { meaningfulSaveFixture } from './meaningfulSave.testSupport'

installBoardTestLifecycle()
type Fixture = Awaited<ReturnType<typeof meaningfulSaveFixture>>
type EditKind = 'graph-only' | 'update-agent' | 'create-agent'
const draft = (f: Fixture) => useGraphDraftStore.getState().nextDrafts[f.key]!
const saveBar = () => within(screen.getByRole('region', { name: 'Workflow authoring' }))
const saveDialog = () => screen.findByRole('alertdialog', { name: 'Stop running work and save?' })
async function mount(f: Fixture) {
  const wire = measureBoardWire(f.mock, f.reply), view = await mountMeasuredBoard(f.href)
  await screen.findByRole('region', { name: 'Workflow authoring' })
  await waitFor(() => expect(draft(f)).toBeDefined())
  await waitFor(() => expect(view.cache.getQueryState(graphEditIntentKey(f.workspaceId, f.workflowId, draft(f).context.draft.id)))
    .toMatchObject({ status: 'success', fetchStatus: 'idle' }))
  // Do not install an initialContext or seed nextDraftApi's cache by hand: the
  // old writer must also have a genuinely opened transport draft in this test.
  return { ...view, wire }
}
function change(f: Fixture, kind: EditKind = 'update-agent', graphChange = true) {
  act(() => useGraphDraftStore.getState().updateNextDraft(f.key, (current) => {
    let graph: WorkflowDefinitionV3 = graphChange ? { ...current.graph, nodes: current.graph.nodes.map((node, index) => index ? node
      : { ...node, initialPrompt: 'Atomically published graph instructions' }) } : current.graph
    const agentEdits = { ...current.agentEdits }
    if (kind === 'update-agent') {
      const agent = current.context.agents[0]!.agent
      agentEdits[agent.id] = { ...agent, name: 'Changed shared Agent', description: 'Atomically published Agent instructions',
        harnessConfiguration: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'synthetic-edited-model' } }
    } else if (kind === 'create-agent') {
      const agent: Agent = { id: 'new-staged-agent', name: 'New staged Agent', productRole: 'coder', harness: 'codex',
        harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [] }
      agentEdits[agent.id] = agent
      graph = { ...graph, nodes: [...graph.nodes, { id: 'new-node', agentId: agent.id, name: agent.name, position: { x: 500, y: 200 } }],
        edges: [...graph.edges, { id: 'new-handoff', source: nativeNode(graph.nodes[0]!).id, target: 'new-node', kind: 'execution' }] }
    }
    return { ...current, graph, agentEdits, history: [...current.history, current.graph] }
  }))
  return structuredClone({ graph: draft(f).graph, agentEdits: draft(f).agentEdits })
}
async function readSaved(f: Fixture) {
  const [definition, agents] = await Promise.all([
    apiClient.request(`${f.path}/definition`, CurrentWorkflowReadResultSchema), apiClient.listManagedAgents(f.workspaceId),
  ])
  return { definition, agents: agents.items }
}
function expectRetained(f: Fixture, submitted: ReturnType<typeof change>) {
  expect(nextDraftDirty(draft(f))).toBe(true)
  expect(draft(f).graph).toEqual(submitted.graph)
  expect(draft(f).agentEdits).toEqual(submitted.agentEdits)
  expect(readEditOutbox(f.key)?.request).toEqual(f.requests.stages[0])
}

// These cases mount the REGISTERED Board, not a mocked hook, writer, ApiClient,
// or current-workflow count. Only HTTP and JSDOM infrastructure are synthetic.
describe('meaningful Save through the real Board transport', () => {
  it('opens and focuses the settings named by a rejected save without losing edits', async () => {
    const f = await meaningfulSaveFixture(), user = userEvent.setup(), reply = f.reply
    f.reply = async (request) => request.method === 'POST' && new URL(request.url).pathname === `${f.path}/definition/edits`
      ? Response.json({ error: { code: 'GRAPH_INVALID', message: 'Fix the workflow settings below.', details: { issues: [
        { code: 'ORCHESTRATOR_REQUIRED', path: ['approval', 'designatedOrchestratorAgentId'], message: 'Choose a reviewing orchestrator.' },
        { code: 'EXECUTION_LIMITS_REQUIRED', path: ['executionPolicy'], message: 'Set execution limits.' },
      ] } } }, { status: 409 }) : reply(request)
    await mount(f)
    change(f, 'graph-only')
    act(() => useGraphDraftStore.getState().updateNextDraft(f.key, (current) => {
      const graph = { ...current.graph, approval: { handler: 'orchestrator' as const } }
      delete graph.executionPolicy
      return { ...current, graph }
    }))
    await user.click(saveBar().getByRole('button', { name: 'Save workflow' }))
    await screen.findByText('Can’t save — fix 2 settings')
    const fixes = screen.getAllByRole('button', { name: 'Fix setting' })
    await user.click(fixes[0]!)
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Reviewing coordinator' })).toHaveFocus())
    await user.click(fixes[1]!)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set limits' })).toHaveFocus())
    expect(nextDraftDirty(draft(f))).toBe(true)
    expect(readEditOutbox(f.key)).toBeUndefined()
    expect(f.requests.publications).toBe(0)
  }, 20000)

  it.each<EditKind>(['graph-only', 'update-agent', 'create-agent'])('%s: rejected publication leaves saved graph and Agents unchanged', async (kind) => {
    const f = await meaningfulSaveFixture(), user = userEvent.setup()
    f.controls.rejectPublish = true
    const { wire } = await mount(f), before = await readSaved(f), submitted = change(f, kind)
    await user.click(saveBar().getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(f.requests.publications).toBe(1))
    // The same fixture accepts standalone Agent POST/PATCH. At the old head
    // those requests commit before the rejected workflow PUT and this fails.
    expect(await readSaved(f)).toEqual(before)
    await screen.findByText('Save is not confirmed.')
    // A valid blocked journal, not an MSW exception or INVALID_RESPONSE, must
    // reach the Board with the definite publication error and original pins.
    const rejected = wire.writes().at(-1)!
    expect(rejected.status).toBe(200)
    expect(rejected.body).toMatchObject({ intent: { state: 'blocked', saveAttempted: true,
      error: { code: 'REVISION_CONFLICT', uncertain: false },
      expectedRevision: before.definition.revision, expectedWorkflowVersionId: before.definition.currentVersionId } })
    expect(f.read().intent?.result).toBeUndefined()
    expectRetained(f, submitted)
    expect(draft(f).context.draft.baseWorkflowVersionId).toBe(before.definition.currentVersionId)
    expect(draft(f).context.draft.revision).toBe(before.definition.revision)
    expect(f.requests.stages).toHaveLength(1)
    expect(f.requests.stages[0]!.graph).toEqual(submitted.graph)
    expect(f.requests.stages[0]!.stagedAgents ?? []).toHaveLength(kind === 'graph-only' ? 0 : 1)
    expect(wire.writes().every((call) => call.path === `${f.path}/definition/edits`)).toBe(true)
    expect(f.stops.size).toBe(0); expect(f.mock.runs.size).toBe(0)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  }, 20000)

  it('without any Run, publishes graph plus Agent but acknowledges neither until the saved receipt arrives', async () => {
    const f = await meaningfulSaveFixture(), user = userEvent.setup()
    // Save with an empty affected set must not require Stop permission.
    f.mock.controls.deniedStop = true
    let release!: () => void
    f.controls.holdSaveReply = new Promise<void>((resolve) => { release = resolve })
    const { wire } = await mount(f), before = await readSaved(f), submitted = change(f)
    try {
      await user.click(saveBar().getByRole('button', { name: 'Save workflow' }))
      await waitFor(() => expect(f.read().intent?.state).toBe('saved'))
      // The server committed, but its response is still held. No receipt has
      // reached the Board and the exact local submission must remain dirty.
      expectRetained(f, submitted)
      expect(draft(f).context.draft.baseWorkflowVersionId).toBe(before.definition.currentVersionId)
      expect(f.requests.advances).toHaveLength(1)
      expect(f.stops.size).toBe(0)
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    } finally { release() }
    await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
    expect(readEditOutbox(f.key)).toBeUndefined()
    const after = await readSaved(f), id = before.agents[0]!.agent.id
    expect(after.agents[0]!.agent.name).toBe(submitted.agentEdits![id]!.name)
    expect(nativeNode(after.definition.version.definition.nodes[0]!).initialPrompt).toBe(nativeNode(submitted.graph.nodes[0]!).initialPrompt)
    expect(after.definition.version.agentConfigurationVersionIds[id]).toBe(after.agents[0]!.agent.configurationVersionId)
    expect(draft(f).context.draft.baseWorkflowVersionId).toBe(after.definition.currentVersionId)
    expect(wire.writes().map((call) => call.path)).toEqual([`${f.path}/definition/edits`, `${f.path}/definition/edits`])
  }, 20000)

  it('a lost saved reply is reconciled by receipt readback without another publication or Start', async () => {
    const f = await meaningfulSaveFixture(), user = userEvent.setup(); f.controls.loseSaveReply = true
    const { cache, wire } = await mount(f), submitted = change(f)
    await user.click(saveBar().getByRole('button', { name: 'Save workflow' }))
    await screen.findByText('Save not confirmed.')
    expect(f.read().intent?.state).toBe('saved')
    expectRetained(f, submitted)
    await act(async () => { await cache.invalidateQueries() })
    await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
    expect(readEditOutbox(f.key)).toBeUndefined()
    expect(screen.queryByText('Can’t save.')).not.toBeInTheDocument()
    expect(screen.queryByText('Save not confirmed.')).not.toBeInTheDocument()
    expect(f.requests.publications).toBe(1); expect(f.requests.advances).toHaveLength(1)
    expect(wire.writes().every((call) => call.path === `${f.path}/definition/edits`)).toBe(true)
    expect(f.mock.runs.size).toBe(0)
  }, 20000)

  it('discovers only the other workflow’s Run for an Agent-only edit, confirms Stop, and waits for cleanup', async () => {
    const f = await meaningfulSaveFixture(true), user = userEvent.setup(), { cache, wire } = await mount(f)
    const before = await readSaved(f), submitted = change(f, 'update-agent', false)
    const run = [...f.mock.runs.values()][0]!.run, pins = structuredClone(run.agentConfigurationVersionIds)
    const otherVersion = structuredClone(f.mock.versions.get(run.workflowVersionId)!)
    expect(f.mock.details().runs.filter((item) => item.workflowId === f.workflowId)).toEqual([])
    expect(f.mock.details().runs.filter((item) => item.workflowId !== f.workflowId)).toHaveLength(1)
    for (const workflow of f.mock.workflows.values()) expect(workflow.nodes.some((node) => nativeNode(node).agentId === before.agents[0]!.agent.id)).toBe(true)
    await user.click(saveBar().getByRole('button', { name: 'Save workflow' }))
    const dialog = await saveDialog()
    expect(dialog).toHaveTextContent('1 affected Run requires Stop or cleanup across 1 workflow')
    expect(dialog).toHaveTextContent('another workflow')
    expect(f.read().intent!.affected.map((item) => item.runId)).toEqual([run.id])
    expect(f.requests.advances).toEqual([]); expect(f.stops.size).toBe(0)
    expect(await readSaved(f)).toEqual(before)
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }))
    expectRetained(f, submitted)
    await user.click(saveBar().getByRole('button', { name: 'Stop affected Runs and save' }))
    await user.click(within(await saveDialog()).getByRole('button', { name: 'Stop runs and save' }))
    await waitFor(() => expect(f.read().intent?.state).toBe('waiting'))
    expect([...f.stops]).toEqual([run.id]); expect(f.mock.controls.stopCalls).toBe(1)
    expectRetained(f, submitted)
    // Terminal is not settled while native cleanup remains pending.
    f.mock.settle(run.id, true)
    await act(async () => { await cache.invalidateQueries() })
    expectRetained(f, submitted); expect(await readSaved(f)).toEqual(before)
    f.mock.settle(run.id)
    await act(async () => { await cache.invalidateQueries() })
    await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
    const after = await readSaved(f), agentId = before.agents[0]!.agent.id
    expect(after.definition.version.agentConfigurationVersionIds[agentId]).toBe(after.agents[0]!.agent.configurationVersionId)
    expect(after.definition.currentVersionId).not.toBe(before.definition.currentVersionId)
    expect(f.mock.versions.get(run.workflowVersionId)).toEqual(otherVersion)
    expect(f.mock.runs.get(run.id)!.run.agentConfigurationVersionIds).toEqual(pins)
    expect(f.mock.runs.size).toBe(1); expect(f.mock.controls.stopCalls).toBe(1)
    expect(f.requests.publications).toBe(1)
    for (const replay of f.requests.stages) expect(replay).toEqual(f.requests.stages[0])
    expect(wire.writes().every((call) => call.path === `${f.path}/definition/edits`)).toBe(true)
  }, 20000)

  it('missing Stop permission for the other workflow is a clear blocker, with the edit retained', async () => {
    const f = await meaningfulSaveFixture(true), user = userEvent.setup(); f.mock.controls.deniedStop = true
    const { wire } = await mount(f), before = await readSaved(f), submitted = change(f, 'update-agent', false)
    await user.click(saveBar().getByRole('button', { name: 'Save workflow' }))
    await screen.findByText('You don’t have permission to stop every affected run.')
    expect(saveBar().getByRole('button', { name: 'Stop affected Runs and save' })).toBeDisabled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expectRetained(f, submitted); expect(await readSaved(f)).toEqual(before)
    expect(f.requests.advances).toEqual([]); expect(f.stops.size).toBe(0)
    expect(wire.writes()).toHaveLength(1)
  }, 20000)

  it.each(['permission-revoked', 'affected-set-changed'] as const)('rechecks %s after the confirmation is displayed', async (cut) => {
    const f = await meaningfulSaveFixture(true), user = userEvent.setup(); await mount(f)
    const before = await readSaved(f), submitted = change(f, 'update-agent', false)
    await user.click(saveBar().getByRole('button', { name: 'Save workflow' }))
    const dialog = await saveDialog(), request = readEditOutbox(f.key)!.request
    if (cut === 'permission-revoked') f.mock.controls.deniedStop = true
    else f.mock.controls.affectedSetChanged = true
    await user.click(within(dialog).getByRole('button', { name: 'Stop runs and save' }))
    await screen.findByText(cut === 'permission-revoked' ? 'You don’t have permission to stop every affected run.'
      : 'New runs started with these agents. Discard this save and try again.')
    expectRetained(f, submitted); expect(await readSaved(f)).toEqual(before)
    expect(f.requests.advances).toEqual([]); expect(f.stops.size).toBe(0)
    expect(f.requests.stages.length).toBeGreaterThan(1)
    for (const replay of f.requests.stages) expect(replay).toEqual(request)
  }, 20000)
})
