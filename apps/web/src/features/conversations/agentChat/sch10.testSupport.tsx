import { useLayoutEffect, useReducer } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, render, screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, AgentChatStateSchema, type AgentChatState, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { ReadSelectedRunChatResponseSchema, type SelectedRunChatExecution } from '@foreman-code/contracts/selected-run-chat'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { RunActivitiesPageSchema } from '@foreman-code/contracts/wave25'
import { RunsSelector } from '../../runs-selector/RunsSelector'
import { RunsSelectorSearchSchema } from '../../runs-selector/search'
import { useSelectedRun, type SelectedRunState } from '../../runs-selector/useSelectedRun'
import { Activities } from '../../workflow-board/Activities'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'

export const scope = { workspaceId: 'workspace-schedule', workflowId: 'workflow-schedule' }
export const nodeId = 'node-shared', agentId = 'agent-shared', at = '2026-09-28T03:00:00.000Z'
export const selectedRoute = '*/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId'
export const snapshotRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot'
export const summariesRoute = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries'
export const activitiesRoute = '*/api/management/workspaces/:workspaceId/runs/:runId/activities'
export const clients: QueryClient[] = []
export const execution = (runId: string, executionId = `execution-${runId}`, workflowNodeId = nodeId): SelectedRunChatExecution =>
  ({ ...scope, runId, executionId, workflowNodeId })
export const context = (runId?: string) => ({ ...scope, workflowNodeId: nodeId, agentId, ...(runId ? { runId } : {}) })

/** Contract-validated wire fixtures; no native harness or background completion simulation. */
export function historicalState(runId: string, executionId = `execution-${runId}`): AgentChatState {
  const state = agentChatFixtureFor(agentChatFixtures.idleAfterCompletion, context(runId), `conversation-${executionId}`)
  if (!state.conversation || state.conversation.origin.kind !== 'run_execution') throw new Error('Expected a Run fixture')
  state.conversation.origin.executionId = executionId
  state.messages = [{ id: `question-${executionId}`, conversationId: state.conversation.id, role: 'user',
    content: `Question ${executionId}`, requestId: `request-${executionId}` },
  { id: `reply-${executionId}`, conversationId: state.conversation.id, role: 'assistant',
    content: `Reply ${executionId}`, requestId: `request-${executionId}`, nativeMessageComplete: true }]
  state.turns = [{ requestId: `request-${executionId}`, messageId: `question-${executionId}`, sequence: '1',
    intent: 'next_turn', delivery: 'completed', createdAt: at, updatedAt: at }]
  state.activities = []; state.activeTurn = null; state.sessionState = 'idle'
  state.availability = { canSend: true }; state.capabilities.resume = true; state.hasEarlierMessages = false
  return AgentChatStateSchema.parse(state)
}
export function envelope(state: AgentChatState, target = execution(state.context.runId!)) {
  return ReadSelectedRunChatResponseSchema.parse({ kind: 'selected', selection: target,
    key: state.conversation ? { ...target, agentId: state.conversation.agentId, conversationId: state.conversation.id } : null, state })
}
export function snapshot(runId: string) {
  return RunBoardSnapshotGetResultSchema.parse({ snapshot: { kind: 'available', ...scope, runId,
    workflowVersionId: `version-${runId}`, capturedAt: at, edges: [], nodes: [{ id: nodeId, name: 'Removed Coder', agentId,
      agentConfigurationVersionId: 'config-historical', position: { x: 20, y: 20 }, size: { width: 240, height: 100 } }] } })
}
export function activityPage(runId: string, executionId = `execution-${runId}`, summary = `Run activity ${executionId}`, sequence = '1', olderCursor: string | null = null) {
  const pin = { ...scope, runId, workflowVersionId: `version-${runId}`, executionSemanticsVersion: 3 as const }
  return RunActivitiesPageSchema.parse({ scope: pin, mode: 'initial', highWater: '10', retainedFrom: '1', nextCursor: `cursor-${runId}`,
    olderCursor, hasMore: false, items: [{ id: `activity-${executionId}-${sequence}`, scope: pin, sequence, occurredAt: at,
      source: 'harness', kind: 'agent_work', status: 'completed', severity: 'info', summary,
      actor: { agentId, agentName: 'Removed Coder', nodeId, nodeName: 'Removed Coder' }, refs: { executionId } }] })
}
export function admitted(before: AgentChatState, input: Omit<SendAgentChatMessageRequest, 'context'>, target = execution(before.context.runId!)) {
  const state = structuredClone(before)
  if (!state.conversation) state.conversation = historicalState(target.runId, target.executionId).conversation
  const turn = { requestId: input.requestId, messageId: `message-${input.requestId}`, intent: input.intent,
    sequence: String(state.turns.length + 1), delivery: 'queued' as const, createdAt: at, updatedAt: at }
  state.turns.push(turn)
  state.messages.push({ id: turn.messageId, conversationId: state.conversation!.id, role: 'user', content: input.content, requestId: input.requestId })
  state.sessionState = 'idle'; state.revision++
  return { state: AgentChatStateSchema.parse(state), turn, replayed: false }
}
export const summary = (runId: string) => ({ runId, shortId: runId, startedAt: at, status: 'succeeded' as const, trigger: 'manual' as const })
export function installSelectedHandlers() {
  const states = new Map(['run-a', 'run-b'].map((id) => [id, historicalState(id)]))
  const reads: string[] = [], posts: { runId: string; body: Record<string, unknown> }[] = []
  const current = createAgentChatMock(agentChatFixtureFor(agentChatFixtures.empty, context()))
  server.use(...current.handlers,
    http.get(summariesRoute, () => HttpResponse.json({ items: [summary('run-b'), summary('run-a')], pageInfo: { nextCursor: null } })),
    http.get(snapshotRoute, ({ params }) => HttpResponse.json(snapshot(String(params.runId)))),
    http.get(selectedRoute, ({ params, request }) => {
      const runId = String(params.runId), executionId = new URL(request.url).searchParams.get('executionId') ?? `execution-${runId}`
      reads.push(request.url)
      return HttpResponse.json(envelope(states.get(runId)!, execution(runId, executionId, String(params.workflowNodeId))))
    }),
    http.get(activitiesRoute, ({ params }) => HttpResponse.json(activityPage(String(params.runId)))),
    http.post(`${selectedRoute}/messages`, async ({ request, params }) => {
      const body = await request.json() as Record<string, unknown>, runId = String(params.runId)
      posts.push({ runId, body })
      const result = admitted(states.get(runId)!, body as unknown as Omit<SendAgentChatMessageRequest, 'context'>,
        execution(runId, String(body.executionId)))
      states.set(runId, result.state)
      return HttpResponse.json(result)
    }),
  )
  server.use(
    http.get('*/api/workspaces/:workspaceId/agent-chat', ({ request }) => {
      const runId = new URL(request.url).searchParams.get('runId')
      if (!runId) return HttpResponse.json(agentChatFixtureFor(agentChatFixtures.empty, context()))
      reads.push(request.url)
      return HttpResponse.json(states.get(runId))
    }),
    http.post('*/api/workspaces/:workspaceId/agent-chat/messages', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>
      const runId = (body.context as { runId: string }).runId
      posts.push({ runId, body })
      const result = admitted(states.get(runId)!, body as unknown as Omit<SendAgentChatMessageRequest, 'context'>)
      states.set(runId, result.state)
      return HttpResponse.json(result)
    }),
  )
  return { states, reads, posts, current }
}

export async function mountSelectedActivities(runId: string | null = 'run-a') {
  let latest!: SelectedRunState
  let refreshView!: () => void
  function Probe() {
    const [, refresh] = useReducer((revision: number) => revision + 1, 0)
    refreshView = refresh
    const selection = useSelectedRun(scope)
    useLayoutEffect(() => { latest = selection }, [selection])
    return <><RunsSelector selection={selection} />
      <output aria-label="Selected Run">{selection.identity.runId ?? 'current'}</output>
      <Activities selection={selection} /></>

  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema, component: Probe })
  const entry = `/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}${runId ? `&selectedRunId=${runId}` : ''}#chat`
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  const rendered = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByLabelText('Selected Run')
  await waitFor(() => expect(latest).toBeDefined())
  return { ...rendered, client, router, selection: () => latest, refreshView: () => act(refreshView),
    select: async (id: string | null) => { await act(async () => { await latest.selectRun(id) }) } }
}
