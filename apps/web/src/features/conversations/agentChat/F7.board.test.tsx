import { savedClaudeConfiguration } from '../../settings/claudeSettings.fixtures'
// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor, agentChatTestActions, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { installBoardTestLifecycle, mountMeasuredBoard } from '../../workflow-board/eng05D.testSupport'
import { inspectionBoardFixture } from '../../workflow-board/inspect/inspectionFixtures'
import { useConversationDraftStore } from '../conversationDraftStore'
import { agentChatContextKey } from './model'
import { chatHarnesses, providerFixture } from './f7.testSupport'
import { installChatSource } from './testSupport'

installBoardTestLifecycle()
afterEach(() => useConversationDraftStore.getState().clearAllDrafts())

async function selectionFixture(harness: typeof chatHarnesses[number], width: number) {
  const fixture = await inspectionBoardFixture(`f7-${harness}-${width}`), mock = fixture.mock
  // Both the saved Run's Agent and its DIFFERENT current-draft replacement have coherent
  // harness/configuration facts. No renderer, popover, editor, route or canvas is substituted.
  if (harness === 'claude') {
    for (let index = 0; index < mock.configurations.length; index++) {
      const previous = mock.configurations[index]!
      mock.configurations[index] = AgentConfigurationVersionSchema.parse({ ...previous, harness: {
        ...savedClaudeConfiguration,
      } })
    }
    for (const agent of mock.agents) {
      agent.harness = 'claude'
      agent.harnessConfiguration = mock.configurations.find((configuration) => configuration.agentId === agent.id)!.harness
    }
  }
  const saved = fixture.runs.before.scope, workflowId = saved.workflowId, workspaceId = saved.workspaceId
  const currentVersion = WorkflowVersionV3Schema.parse({ ...fixture.after,
    agentConfigurationVersionIds: { [fixture.second.agentId]: fixture.after.agentConfigurationVersionIds[fixture.second.agentId] },
    definition: { ...fixture.after.definition, nodes: [{ ...fixture.first, agentId: fixture.second.agentId, name: 'Draft Agent' }], edges: [] } })
  mock.versions.set(currentVersion.id, currentVersion)
  mock.workflows.set(workflowId, currentVersion.definition)
  mock.drafts.set(workflowId, { ...mock.drafts.get(workflowId)!, graph: currentVersion.definition })
  const draftContext: AgentChatContext = { workspaceId, workflowId, workflowNodeId: fixture.first.id, agentId: fixture.second.agentId }
  const runContext: AgentChatContext = { ...draftContext, agentId: fixture.first.agentId, runId: saved.runId }
  const chat = createAgentChatMock(agentChatFixtureFor(providerFixture(harness), draftContext))
  chat.setState(agentChatFixtureFor(providerFixture(harness), runContext))
  server.use(...chat.handlers.slice(1), ...mock.handlers,
    // A saved Run node resolves to a Run execution; this fixture's saved Run recorded none to chat with.
    http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/execution-chat/target', ({ request }) => {
      const target = new URL(request.url).searchParams
      return HttpResponse.json(target.get('runId') ? { kind: 'unavailable', reason: 'NO_EXECUTION' } : { kind: 'outside_run',
        workflowVersionId: currentVersion.id, reason: 'NO_LIVE_RUN', agent: { workspaceId, workflowId,
          workflowNodeId: draftContext.workflowNodeId, agentId: draftContext.agentId } })
    }))
  // Grant chat actions explicitly; this fixture does NOT grant graph writes or Run Stop authority.
  server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
    id: 'f7-board-reader-and-chat-writer', name: 'F7 Board tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
      scope: { workspaceIds: [workspaceId] },
      actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
    }],
  } }))))
  return { fixture, chat, saved, draftContext, runContext }
}

/** Mounted product routeTree -> WorkflowBoard -> NextDraftEditor -> DraftCanvas / saved Run Board
 * -> WorkflowSidePanel -> execution-chat target resolution, with MSW. Width/element measurements are JSDOM test fixtures:
 * these tests exercise placement branches and focus, NOT browser geometry or real native sessions. */
describe.each(chatHarnesses)('mounted Board chat: %s', (harness) => {
  it.each([1280, 390])('keeps pinned-Run and draft Agent chats isolated through the shared rail and URL at %ipx', async (width) => {
    vi.stubGlobal('innerWidth', width); installChatSource()
    const { fixture, chat, saved, draftContext } = await selectionFixture(harness, width)
    const beforeRun = structuredClone(fixture.mock.runs.get(saved.runId))
    const mounted = await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}`)
    const board = screen.getByTestId('unified-workflow-board')
    const draftTrigger = await screen.findByRole('button', { name: 'Open Draft Agent chat' })
    await userEvent.click(draftTrigger)
    const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    const draftInput = await within(rail).findByRole('textbox', { name: 'Message' })
    await waitFor(() => expect(draftInput).toHaveFocus())
    fireEvent.change(draftInput, { target: { value: 'Unsent draft Agent text' } })
    expect(within(rail).getByTestId('agent-conversation')).toHaveAttribute('data-chat-key', agentChatContextKey(draftContext))
    await act(async () => { await mounted.router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: saved.workspaceId },
      search: { workflowId: saved.workflowId, runId: saved.runId, workflowVersionId: saved.workflowVersionId, executionSemanticsVersion: 3 } }) })
    await screen.findByRole('region', { name: 'Selected Run board' })
    expect(screen.getByTestId('unified-workflow-board')).toBe(board)
    const runName = fixture.first.name!, runTrigger = await screen.findByRole('button', { name: `Inspect ${runName}` })
    await userEvent.click(runTrigger)
    const runRail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(runRail).toBe(rail)
    await userEvent.click(within(runRail).getByRole('button', { name: 'Chat' }))
    // The saved Run's chat is its own target; the draft Agent's unsent text and conversation never reach it.
    expect(await within(runRail).findByText(/This saved node has no available execution/)).toBeVisible()
    expect(within(runRail).queryByTestId('agent-conversation')).not.toBeInTheDocument()
    expect(within(runRail).queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    expect(mounted.history.location.search).toContain(`runId=${saved.runId}`)
    expect(chat.getState(draftContext).conversation).toBeNull()
    expect(chat.calls.filter((call) => call.method === 'POST')).toEqual([])
    expect(fixture.mock.runs.get(saved.runId)).toEqual(beforeRun)
    expect(fixture.mock.calls.filter((call) => call.method !== 'GET')).toEqual([])
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument())
    await waitFor(() => expect(runTrigger).toHaveFocus())
    await userEvent.click(screen.getByRole('button', { name: /^Runs$/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'New run' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument())
    if (!screen.queryByRole('complementary', { name: 'Workflow side panel' })) await userEvent.click(screen.getByRole('button', { name: 'Open Draft Agent chat' }))
    const returned = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(screen.getAllByTestId('agent-conversation')).toHaveLength(1)
    expect(await within(returned).findByRole('textbox', { name: 'Message' })).toHaveValue('Unsent draft Agent text')
    expect(screen.getByTestId('unified-workflow-board')).toBe(board)
    expect(mounted.history.location.search).not.toContain('runId=')
    expect(chat.calls.filter((call) => call.method === 'POST')).toEqual([])
  }, 30_000)
})
