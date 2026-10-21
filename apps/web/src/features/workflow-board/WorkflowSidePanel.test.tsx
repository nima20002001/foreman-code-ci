// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useLocation } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineChatReadbackSchema, collaborationContractFixtures } from '@foreman-code/contracts'
import { Button, Textarea } from '../../shared/ui/nocturne'
import { resolveRunsSelectorBoardLocation, RunsSelectorSearchSchema } from '../runs-selector/search'
import { useWorkflowSidePanel } from './useWorkflowSidePanel'
import { WorkflowMemoryDialog, WorkflowSidePanel, type WorkflowCollaborationSlots } from './WorkflowSidePanel'
import { WorkflowOperatorChat, WorkflowOperatorDockProvider } from './WorkflowOperatorDock'
import { useWorkflowOperatorDock } from './operatorDockContext'
import { OperatorChatVisibilityProvider } from '../operator-chat/visibility'
import { useSelectedRun } from '../runs-selector/useSelectedRun'
import { useSidePanelPresentation } from './sidePanelPresentation'

afterEach(() => { cleanup(); vi.restoreAllMocks(); useSidePanelPresentation.setState({ beforeOperator: {} }) })

/** A public consumer of the shell slots. Its local draft owner outlives selected bodies. */
function ShellFixture({ slots }: { slots?: WorkflowCollaborationSlots }) {
  const location = useLocation()
  const resolved = resolveRunsSelectorBoardLocation(location.pathname, location.search)
  const side = useWorkflowSidePanel('workspace', 'workflow', resolved.run, slots?.beforeBrowserHide)
  const selectedRun = useSelectedRun({ workspaceId: 'workspace', workflowId: 'workflow' })
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  useWorkflowOperatorDock(side.scope, host, side.panel.kind === 'operator', side.memoryOpen, side.selectPanel, side.closeOperator)
  const readback = EngineChatReadbackSchema.parse(collaborationContractFixtures.executionReadback)
  return <>
    <nav aria-label="Board controls">
      <Button onClick={() => side.selectPanel({ kind: 'agent', nodeId: 'node-a', tab: 'settings' })}>Open Agent settings</Button>
      <Button onClick={() => side.selectPanel({ kind: 'group_chat' })}>Open Group chat</Button>
      <Button onClick={() => side.setMemoryOpen(true)}>Memory board</Button>
      <Button onClick={() => side.selectView('overview')}>Overview</Button>
      <Button onClick={() => side.selectView('graph')}>Graph</Button>
      <Button onClick={() => void selectedRun.selectRun('run-b')}>Select Run B</Button>
      <Button onClick={() => void selectedRun.selectRun(null)}>Return to draft</Button>
      <Button onClick={side.closeOperator}>Close Operator</Button>
    </nav>
    <main aria-label="Board canvas">{side.view === 'overview' ? 'Overview is not available yet.' : 'Editing surface'}
      <p>{readback.messages[0]!.content}</p>
    </main>
    <WorkflowSidePanel scope={side.scope} workspaceId="workspace" workflowId="workflow" opener={side.opener} runId={resolved.run?.runId}
      workflowVersionId={resolved.run?.workflowVersionId} slots={slots}
      selection={side.panel} agentSelection={side.agentSelection} onSelect={side.selectPanel}
      onSelectTarget={side.selectChatTarget} onSelectRun={side.selectChatRun}
      bodyRef={setHost} modalOpen={side.memoryOpen} />
    {host && side.panel.kind === 'agent' && !side.panel.executionId && !side.memoryOpen
      && (!slots?.executionChat || side.panel.tab !== 'chat')
      ? createPortal(<div role="region" aria-label="Fixture transcript" className="fixture-scroll">
        <Textarea autoFocus label="Agent settings draft" value={draft}
          onChange={event => setDraft(event.target.value)} /></div>, host) : null}
    <WorkflowMemoryDialog open={side.memoryOpen} onOpenChange={side.setMemoryOpen} slots={slots} />
  </>
}

function mount(entry: string, slots?: WorkflowCollaborationSlots) {
  const root = createRootRoute({ component: Outlet })
  const board = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema.parse, component: () => <ShellFixture slots={slots} /> })
  const pinned = createRoute({ getParentRoute: () => root,
    path: '/workspaces/$workspaceId/workflows/$workflowId/runs/$runId/graph/$workflowVersionId/3',
    validateSearch: RunsSelectorSearchSchema.parse, component: () => <ShellFixture slots={slots} /> })
  const router = createRouter({ routeTree: root.addChildren([board, pinned]),
    history: createMemoryHistory({ initialEntries: [entry] }) })
  render(<OperatorChatVisibilityProvider enabled={false}><WorkflowOperatorDockProvider>
    <RouterProvider router={router} /><WorkflowOperatorChat />
  </WorkflowOperatorDockProvider></OperatorChatVisibilityProvider>)
  return router
}

describe('disabled collaboration shell through navigation and rendered controls', () => {
  it('explains a hidden Operator destination without mounting a conversation or making requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), user = userEvent.setup()
    mount('/workspaces/workspace?workflowId=workflow&boardPanel=operator')
    const warning = await screen.findByText('Operator chat is hidden in Agent settings.')
    expect(warning).toHaveAttribute('role', 'status')
    expect(warning).toBeVisible()
    expect(warning).toHaveTextContent('Operator chat is hidden in Agent settings.')
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to Board' }))
    expect(screen.queryByText('Operator chat is hidden in Agent settings.')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['Select Run B', 'Return to draft'])('does not restore an old execution after Operator navigation to %s', async destination => {
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3&boardPanel=agent&boardNodeId=node-a&boardExecutionId=execution-a&boardAgentTab=chat')
    await screen.findByText(/Chat for this selected execution is not available yet/)
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
      .getByRole('button', { name: 'Operator' }))
    await userEvent.click(screen.getByRole('button', { name: destination }))
    await userEvent.click(screen.getByRole('button', { name: 'Close Operator' }))
    await waitFor(() => expect(router.state.location.search.boardPanel).not.toBe('operator'))
    expect(router.state.location.search.boardExecutionId).toBeUndefined()
    expect(router.state.location.search.boardWaitingActivationId).toBeUndefined()
    expect(router.state.location.search.selectedRunId).toBe(destination === 'Select Run B' ? 'run-b' : undefined)
    expect(RunsSelectorSearchSchema.safeParse(router.state.location.search).success).toBe(true)
    expect(screen.queryByText(/Chat for this selected execution is not available yet/)).not.toBeInTheDocument()
  })

  it('restores the URL-owned execution when Operator closes in the same Run', async () => {
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3&boardPanel=agent&boardNodeId=node-a&boardExecutionId=execution-a&boardAgentTab=chat')
    await screen.findByText(/Chat for this selected execution is not available yet/)
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
      .getByRole('button', { name: 'Operator' }))
    await userEvent.click(screen.getByRole('button', { name: 'Close Operator' }))
    await screen.findByText(/Chat for this selected execution is not available yet/)
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      boardPanel: 'agent', boardNodeId: 'node-a', boardExecutionId: 'execution-a' })
  })

  it('keeps local drafts, retained selection and width across destination, modal and history changes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const router = mount('/workspaces/workspace?workflowId=workflow')
    const user = userEvent.setup()
    const opener = await screen.findByRole('button', { name: 'Open Agent settings' })
    await user.click(opener)
    await user.type(await screen.findByRole('textbox', { name: 'Agent settings draft' }), 'Keep this unsaved edit')
    const rail = within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
    const width = rail.getByRole('slider', { name: 'Panel width' })
    fireEvent.change(width, { target: { value: '520' } })
    const retainedWidth = width.getAttribute('aria-valuetext')
    fireEvent.scroll(screen.getByRole('region', { name: 'Fixture transcript' }), { target: { scrollTop: 125 } })
    await user.click(rail.getByRole('button', { name: /^Group chat$/ }))
    expect(await screen.findByText('Group chat is not available yet.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Agent settings draft' })).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ boardPanel: 'group_chat', boardNodeId: 'node-a', boardAgentTab: 'settings' })
    await act(async () => { router.history.back() })
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    expect(screen.getByRole('region', { name: 'Fixture transcript' }).scrollTop).toBe(125)
    await act(async () => { router.history.forward() })
    await screen.findByText('Group chat is not available yet.')
    await user.click(rail.getByRole('button', { name: /^Agent$/ }))
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    expect(rail.getByRole('slider', { name: 'Panel width' })).toHaveAttribute('aria-valuetext', retainedWidth)
    await user.click(screen.getByRole('button', { name: /^Memory board$/ }))
    expect(await screen.findByRole('dialog', { name: 'Memory board' })).toBeVisible()
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close Memory board' }))
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    await user.click(rail.getByRole('button', { name: 'Back to Board' }))
    await waitFor(() => expect(opener).toHaveFocus())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('carries path-owned immutable Run pins through every shell navigation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), user = userEvent.setup()
    const router = mount('/workspaces/workspace/workflows/workflow/runs/run-a/graph/version-a/3?boardPanel=agent&boardNodeId=node-a&boardExecutionId=execution-a')
    await screen.findByText(/Chat for this selected execution is not available yet/)
    await user.click(screen.getByRole('button', { name: 'Open Group chat' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ workflowId: 'workflow',
      runId: 'run-a', workflowVersionId: 'version-a', executionSemanticsVersion: 3,
      boardPanel: 'group_chat', boardNodeId: 'node-a', boardExecutionId: 'execution-a' }))
    await user.click(within(screen.getByRole('complementary', { name: 'Workflow side panel' })).getByRole('button', { name: 'Browser' }))
    expect(await screen.findByText(/No browser session has been started/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Overview$/ }))
    await user.click(screen.getByRole('button', { name: /^Memory board$/ }))
    await screen.findByRole('dialog', { name: 'Memory board' })
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      boardView: 'overview', boardPanel: 'browser', boardExecutionId: 'execution-a', boardMemory: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('mounts only the selected injected body and retains the exact held execution across modal and destination changes', async () => {
    const selected = vi.fn(), events: string[] = []
    function Body({ name }: { name: string }) {
      useEffect(() => { events.push(`open ${name}`); return () => { events.push(`close ${name}`) } }, [name])
      return <p>{name} body</p>
    }
    const path = '/workspaces/workspace/workflows/workflow/runs/run-a/graph/version-a/3'
    const router = mount(`${path}?boardPanel=agent&boardNodeId=master-node&boardExecutionId=held-execution`, {
      executionChat: value => { selected(value); return <Body name="Execution" /> },
      groupChat: () => <Body name="Group" />, memoryBoard: () => <Body name="Memory" />,
    })
    await screen.findByText('Execution body')
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'workspace', workflowId: 'workflow', runId: 'run-a',
      workflowVersionId: 'version-a', nodeId: 'master-node', executionId: 'held-execution' }))
    expect(events).toEqual(['open Execution'])
    await userEvent.click(screen.getByRole('button', { name: 'Memory board' }))
    await screen.findByText('Memory body')
    expect(router.state.location.pathname).toBe(path)
    expect(screen.queryByText('Execution body')).not.toBeInTheDocument()
    expect(events).toEqual(['open Execution', 'close Execution', 'open Memory'])
    await userEvent.click(screen.getByRole('button', { name: 'Close Memory board' }))
    await screen.findByText('Execution body')
    expect(events.slice(-2)).toEqual(['close Memory', 'open Execution'])
    await userEvent.click(screen.getByRole('button', { name: 'Open Group chat' }))
    await screen.findByText('Group body')
    expect(screen.queryByText('Execution body')).not.toBeInTheDocument()
    expect(events.slice(-2)).toEqual(['close Execution', 'open Group'])
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Workflow side panel' })).getByRole('button', { name: 'Agent' }))
    await screen.findByText('Execution body')
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-a', workflowVersionId: 'version-a', executionId: 'held-execution' }))
  })

  it('requests owned browser release before hiding and keeps navigation available while that release is pending', async () => {
    const events: string[] = [], browser = vi.fn()
    function BrowserBody() {
      useEffect(() => { events.push('visible'); return () => { events.push('hidden') } }, [])
      return <p>Owned browser view</p>
    }
    const release = vi.fn(() => { events.push('release requested'); return new Promise<void>(() => undefined) })
    const router = mount('/workspaces/workspace/workflows/workflow/runs/run-a/graph/version-a/3?boardPanel=browser&boardNodeId=worker-node&boardExecutionId=execution-a', {
      browser: selection => { browser(selection); return <BrowserBody /> }, beforeBrowserHide: release,
      groupChat: () => <p>Selected Group chat</p>,
    })
    await screen.findByText('Owned browser view')
    expect(browser).toHaveBeenLastCalledWith({ kind: 'browser', workspaceId: 'workspace', workflowId: 'workflow',
      runId: 'run-a', workflowVersionId: 'version-a', nodeId: 'worker-node', executionId: 'execution-a' })
    await userEvent.click(screen.getByRole('button', { name: 'Open Group chat' }))
    await screen.findByText('Selected Group chat')
    expect(events).toEqual(['visible', 'release requested', 'hidden'])
    expect(release).toHaveBeenCalledOnce()
    const rail = within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
    await userEvent.click(rail.getByRole('button', { name: 'Browser' }))
    await screen.findByText('Owned browser view')
    await userEvent.click(screen.getByRole('button', { name: 'Memory board' }))
    await screen.findByRole('dialog', { name: 'Memory board' })
    expect(events.slice(-3)).toEqual(['visible', 'release requested', 'hidden'])
    expect(release).toHaveBeenCalledTimes(2)
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a', boardMemory: true })
  })

  it('commits exact consultation and execution targets to URL history, retaining consultation pins until an explicit new Run choice', async () => {
    const selected = vi.fn(), agent = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'master-node', agentId: 'agent-master' }
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3&boardPanel=agent&boardNodeId=master-node', {
      executionChat: value => {
        selected(value)
        return <section aria-label="Exact chat navigation">
          <p>{value.waitingActivationId ?? value.executionId ?? 'Choose exact work'}</p>
          <Button onClick={() => value.onSelectTarget({ kind: 'workflow_coordinator', agent,
            runId: 'run-a', waitingActivationId: 'waiting-a' }, 'version-a')}>Select waiting coordinator</Button>
          <Button onClick={() => value.onSelectTarget({ kind: 'workflow_execution', agent, execution: {
            runId: 'run-a', workflowVersionId: 'version-a', executionId: 'held-a', activationId: 'activation-a', attempt: 1,
          } }, 'version-a')}>Select held execution</Button>
          <Button onClick={() => value.onSelectRun({ runId: 'run-b', workflowVersionId: 'version-b' })}>Choose another Run</Button>
        </section>
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Select waiting coordinator' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      boardNodeId: 'master-node', boardWaitingActivationId: 'waiting-a', boardAgentTab: 'chat' }))
    expect(router.state.location.search).not.toHaveProperty('boardExecutionId')
    await userEvent.click(screen.getByRole('button', { name: 'Open Group chat' }))
    await userEvent.click(screen.getByRole('button', { name: 'Memory board' }))
    await screen.findByRole('dialog', { name: 'Memory board' })
    expect(router.state.location.search).toMatchObject({ boardWaitingActivationId: 'waiting-a' })
    await userEvent.click(screen.getByRole('button', { name: 'Close Memory board' }))
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Workflow side panel' })).getByRole('button', { name: 'Agent' }))
    expect(await screen.findByText('waiting-a')).toBeVisible()
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ waitingActivationId: 'waiting-a', runId: 'run-a', workflowVersionId: 'version-a' }))
    await userEvent.click(screen.getByRole('button', { name: 'Select held execution' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ boardExecutionId: 'held-a' }))
    expect(router.state.location.search).not.toHaveProperty('boardWaitingActivationId')
    await act(async () => { router.history.back() })
    expect(await screen.findByText('waiting-a')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Choose another Run' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ runId: 'run-b', workflowVersionId: 'version-b', boardNodeId: 'master-node' }))
    expect(router.state.location.search).not.toHaveProperty('boardExecutionId')
    expect(router.state.location.search).not.toHaveProperty('boardWaitingActivationId')
    expect(await screen.findByText('Choose exact work')).toBeVisible()
  })

  it('keeps a query-selected Run responsive across panel changes and browser history', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3')
    await user.click(await screen.findByRole('button', { name: 'Open Group chat' }))
    expect(await screen.findByText('Group chat is not available yet.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Overview$/ }))
    expect(screen.getByRole('main', { name: 'Board canvas' })).toHaveTextContent('Overview is not available yet.')
    await act(async () => { router.history.back() })
    await waitFor(() => expect(screen.getByRole('main', { name: 'Board canvas' })).toHaveTextContent('Editing surface'))
    expect(router.state.location.search).toMatchObject({ workflowId: 'workflow', runId: 'run-a',
      workflowVersionId: 'version-a', executionSemanticsVersion: 3, boardPanel: 'group_chat' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
