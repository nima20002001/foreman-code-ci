import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLayoutEffect } from 'react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { subagentCapabilities } from '@foreman-code/contracts/subagents'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { runA, runB, runsUrl, reply } from '../run-board/testFixtures'
import { RunBoardSlot } from '../run-board/RunBoardSlot'
import { useSelectedRun } from '../runs-selector/useSelectedRun'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { subagentsKey } from './query'
import { base, child, detail, message, scope, tool } from './testFixtures'
import { layoutSubagents } from './layout'

const clients: QueryClient[] = []
afterEach(() => { clients.forEach((client) => client.clear()); clients.length = 0 })
beforeEach(() => {
  installFlowLayout()
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot',
      ({ params }) => HttpResponse.json(reply(String(params.runId)))),
    http.get(base, () => HttpResponse.json({ items: [detail(), detail(child({ id: 'nested', name: 'Nested', parentSubagentId: 'child-1' }))], nextCursor: null, projection: 'caught-up' })),
    http.get(`${base}/:subagentId`, () => HttpResponse.json(detail())),
    http.get(`${base}/:subagentId/messages`, () => HttpResponse.json({ items: [message()], nextCursor: null, coverage: child().coverage })),
    http.get(`${base}/:subagentId/tools`, () => HttpResponse.json({ items: [tool()], nextCursor: null, coverage: child().coverage })),
  )
})
async function mount(entry = runsUrl('run-a')) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  let selectRun: ReturnType<typeof useSelectedRun>['selectRun'] = async () => { throw new Error('Run selector is not mounted') }
  function Canvas() {
    const selection = useSelectedRun(scope)
    useLayoutEffect(() => { selectRun = selection.selectRun }, [selection.selectRun])
    return <RunBoardSlot selection={selection}><p>Current workflow editor</p></RunBoardSlot>
  }
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema, component: Canvas })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('button', { name: 'Research, Codex, Running' })
  return { client, router, selectRun: (runId: string | null) => selectRun(runId) }
}
describe('Run subagent overlays', () => {
  it('orbits children around their agent and links a nested child to the child that spawned it', async () => {
    await mount()
    const root = screen.getByRole('button', { name: 'Research, Codex, Running' })
    const nested = screen.getByRole('button', { name: 'Nested, Codex, Running' })
    expect(root).toHaveAttribute('data-parent-id', 'node-x')
    expect(nested).toHaveAttribute('data-parent-id', 'child-1')
    // First orbit slots sit lower-left and lower-right of the agent, mirrored across it.
    const center = (orb: HTMLElement) => ({ x: parseFloat(orb.style.left) + 48, y: parseFloat(orb.style.top) + 20 })
    expect(center(root).y).toBeCloseTo(center(nested).y)
    expect(center(root).x).toBeLessThan(center(nested).x)
    const links = [...document.querySelectorAll('.run-subagents-links line')]
    expect(links).toHaveLength(2)
    expect(Number(links[1]!.getAttribute('x1'))).toBeCloseTo(center(root).x)
    expect(Number(links[1]!.getAttribute('y1'))).toBeCloseTo(center(root).y)
    expect(root).toHaveTextContent('Research'); expect(root).toHaveTextContent('Running')
    expect(runA.nodes[0]?.position).toEqual({ x: -80, y: 40 })
  })
  it('keeps finished chips attached and reports terminal status', async () => {
    const { client } = await mount()
    server.use(http.get(base, () => HttpResponse.json({ items: [detail(child({ status: 'completed', finishedAt: '2026-10-03T01:01:00.000Z' }))], nextCursor: null, projection: 'caught-up' })))
    await act(async () => { await client.invalidateQueries({ queryKey: subagentsKey(scope) }) })
    const completed = await screen.findByRole('button', { name: 'Research, Codex, Done' })
    expect(completed).toHaveAttribute('data-inactive', 'true')
    expect(completed).toHaveAttribute('data-parent-id', 'node-x')
  })
  it('opens messages, tools, clipping and lifecycle while controls are unavailable', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Research, Codex, Running' }))
    await screen.findByText('Child answer')
    expect(screen.getByText('Shortened — the full message was 24 KB.')).toBeVisible()
    expect(screen.getByText("Only part of this subagent's conversation was captured.")).toBeVisible()
    expect(screen.getByText('Controls are unavailable for this subagent right now.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Status' })).toHaveTextContent('Running')
    fireEvent.click(screen.getByRole('tab', { name: /Tool calls/ }))
    const call = screen.getByText('read_file')
    expect(call).toBeVisible()
    expect(screen.getByText('Shortened — the full record was 34 KB.')).toBeInTheDocument()
    fireEvent.click(call)
    expect(screen.getByLabelText('Result')).toHaveTextContent('Read result')
  })
  it('owns selection in the URL, supports a fresh deep link, and clears it on close', async () => {
    const { router } = await mount(`${runsUrl('run-a')}#selectedSubagentId=child-1`)
    await screen.findByText('Child answer')
    expect(router.history.location.hash).toContain('selectedSubagentId=child-1')
    fireEvent.click(screen.getByRole('button', { name: 'Close subagent' }))
    await waitFor(() => expect(router.history.location.hash).not.toContain('selectedSubagentId'))
    expect(screen.getByRole('button', { name: 'Research, Codex, Running' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Research, Codex, Running' }))
    await waitFor(() => expect(router.history.location.hash).toContain('selectedSubagentId=child-1'))
    expect(router.history.location.search).toContain('selectedRunId=run-a')
  })
  it('switches directly between orbs with one popover and returns focus to the selected orb', async () => {
    server.use(http.get(`${base}/:subagentId`, ({ params }) => HttpResponse.json(detail(
      params.subagentId === 'nested' ? child({ id: 'nested', name: 'Nested', parentSubagentId: 'child-1' }) : child(),
    ))))
    const { router } = await mount()
    const user = userEvent.setup()
    const first = screen.getByRole('button', { name: 'Research, Codex, Running' })
    const next = screen.getByRole('button', { name: 'Nested, Codex, Running' })
    await user.click(first)
    expect(await screen.findByRole('dialog', { name: 'Research' })).toHaveAttribute('aria-modal', 'false')
    await user.click(next)
    await screen.findByRole('dialog', { name: 'Nested' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'Research' })).not.toBeInTheDocument()
    expect(router.history.location.hash).toContain('selectedSubagentId=nested')
    expect(first).toHaveAttribute('aria-pressed', 'false')
    expect(next).toHaveAttribute('aria-pressed', 'true')
    await user.click(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.history.location.hash).not.toContain('selectedSubagentId')
    expect(next).toHaveFocus()
  })
  it('positions beside its orb and follows canvas movement while staying within the viewport', async () => {
    await mount()
    const orb = screen.getByRole('button', { name: 'Research, Codex, Running' })
    let bounds = new DOMRect(100, 140, 96, 64)
    vi.spyOn(orb, 'getBoundingClientRect').mockImplementation(() => bounds)
    fireEvent.click(orb)
    const popover = await screen.findByRole('dialog', { name: 'Research' })
    await waitFor(() => expect(popover).toHaveStyle({ left: '208px', top: '140px' }))
    bounds = new DOMRect(500, 240, 96, 64)
    await waitFor(() => expect(popover).toHaveStyle({ left: '608px', top: '240px' }))
    bounds = new DOMRect(940, 800, 96, 64)
    await waitFor(() => expect(popover).toHaveStyle({ left: '536px', top: '276px' }))
  })
  it('loads every roster page as Board nodes without a status strip', async () => {
    server.use(http.get(base, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.has('cursor')
      ? { items: [detail(child({ id: 'nested', name: 'Nested', parentSubagentId: 'child-1' }))], nextCursor: null, projection: 'caught-up' }
      : { items: [detail(), detail(child({ id: 'orphan', parentSubagentId: 'missing' }))], nextCursor: 'page-2', projection: 'catching-up' })))
    await mount()
    await screen.findByRole('button', { name: 'Nested, Codex, Running' })
    expect(screen.queryByText(/subagent activity|isn't shown yet/)).not.toBeInTheDocument()
  })
  it('retains the selected helper and its draft after a temporary roster failure', async () => {
    const capabilities = subagentCapabilities('codex-collab')
    capabilities.sendInput = { support: 'supported', qualification: 'passed' }
    const record = detail(child({ nativeMode: 'codex-collab', capabilities }))
    record.availableActions.sendInput = true
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json(record)))
    const { client } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Research, Codex, Running' }))
    await screen.findByText('Child answer')
    const input = screen.getByRole('textbox', { name: 'Message to subagent' })
    fireEvent.change(input, { target: { value: 'Unsent input' } })
    server.use(http.get(base, () => HttpResponse.json({
      error: { code: 'TEMPORARY_FAILURE', message: 'Try again' },
    }, { status: 503 })))
    await act(async () => { await client.invalidateQueries({ queryKey: [...subagentsKey(scope), 'list'] }) })
    expect(screen.getByRole('button', { name: 'Research, Codex, Running' })).toBeVisible()
    expect(screen.getByText('Child answer')).toBeVisible()
    expect(input).toHaveValue('Unsent input')
    expect(await screen.findByText("Couldn't load subagents.")).toBeVisible()
  })
  it('removes cached circles after a denied refresh', async () => {
    const { client } = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Research, Codex, Running' }))
    await screen.findByText('Child answer')
    server.use(http.get(base, () => HttpResponse.json({ error: { code: 'DENIED', message: 'Denied' } }, { status: 403 })))
    await act(async () => { await client.invalidateQueries({ queryKey: subagentsKey(scope) }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Research, Codex, Running' })).not.toBeInTheDocument())
    expect(await screen.findByText("Couldn't load subagents.")).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Child answer')).not.toBeInTheDocument()
  })
  it('keeps a selected child on its exact Run across Run changes and browser history', async () => {
    server.use(http.get(base, ({ params }) => HttpResponse.json({
      items: [detail(child(params.runId === 'run-b'
        ? { id: 'child-b', name: 'B child', runId: runB.runId, workflowVersionId: runB.workflowVersionId }
        : {}))], nextCursor: null, projection: 'caught-up',
    })))
    const { router, selectRun } = await mount(`${runsUrl('run-a')}#view=tools`)
    fireEvent.click(screen.getByRole('button', { name: 'Research, Codex, Running' }))
    await screen.findByText('Child answer')
    await act(async () => { await selectRun('run-b') })
    await screen.findByRole('button', { name: 'B child, Codex, Running' })
    expect(router.history.location.hash).toBe('#view=tools')
    expect(screen.queryByRole('button', { name: 'Research, Codex, Running' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Child answer')).not.toBeInTheDocument()
    await act(async () => { router.history.back() })
    await screen.findByText('Child answer')
    expect(screen.queryByRole('button', { name: 'B child, Codex, Running' })).not.toBeInTheDocument()
    await act(async () => { router.history.forward() })
    await screen.findByRole('button', { name: 'B child, Codex, Running' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('pages messages and tools within the selected child and closes with Escape', async () => {
    const requested: string[] = []
    server.use(
      http.get(`${base}/:subagentId/messages`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        requested.push(`messages:${cursor}`)
        return HttpResponse.json({ items: [message(cursor ? 'message-2' : 'message-1', cursor ? 'Older answer' : 'Child answer')],
          nextCursor: cursor ? null : 'messages-2', coverage: child().coverage })
      }),
      http.get(`${base}/:subagentId/tools`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        requested.push(`tools:${cursor}`)
        return HttpResponse.json({ items: [{ ...tool(), id: cursor ? 'tool-2' : 'tool-1', name: cursor ? 'second_tool' : 'read_file' }],
          nextCursor: cursor ? null : 'tools-2', coverage: child().coverage })
      }),
    )
    const { router } = await mount()
    const trigger = screen.getByRole('button', { name: 'Research, Codex, Running' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: 'Load more messages' }))
    await screen.findByText('Older answer')
    fireEvent.click(screen.getByRole('tab', { name: /Tool calls/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Load more tool calls' }))
    await screen.findByText('second_tool')
    expect(requested).toEqual(expect.arrayContaining(['messages:messages-2', 'tools:tools-2']))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(router.history.location.hash).not.toContain('selectedSubagentId')
    await waitFor(() => expect(trigger).toHaveFocus())
  })
  it('does not attach orphans or cyclic evidence to a guessed parent', () => {
    expect(layoutSubagents(runA.nodes, [child({ parentSubagentId: 'missing' }), child({ id: 'cycle', parentSubagentId: 'cycle' })])).toEqual([])
  })
  it('allows text editing in the child panel without triggering saved-graph keyboard guards', async () => {
    const capabilities = subagentCapabilities('codex-collab')
    capabilities.sendInput = { support: 'supported', qualification: 'passed' }
    server.use(http.get(`${base}/:subagentId`, () => HttpResponse.json({
      subagent: child({ provider: 'codex', nativeMode: 'codex-collab', status: 'waiting', capabilities }),
      availableActions: { sendInput: true, interrupt: false, blockedReason: null },
    })))
    const user = userEvent.setup()
    await mount()
    await user.click(screen.getByRole('button', { name: 'Research, Codex, Running' }))
    const input = await screen.findByRole('textbox', { name: 'Message to subagent' })
    await user.type(input, 'abc{Backspace}')
    expect(input).toHaveValue('ab')
    expect(fireEvent.keyDown(input, { key: 's', ctrlKey: true })).toBe(false)
  })
})
