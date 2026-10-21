// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@foreman-code/contracts'
import { ApprovalInbox } from './ApprovalInbox'
import { useApprovalInboxStore } from './approvalInboxStore'

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn(), workspace: vi.fn() }))
const userApi = vi.hoisted(() => ({ detail: vi.fn(), response: vi.fn(), mutate: vi.fn() }))
vi.mock('../../shared/api/query', () => ({
  useInfiniteInteractionsQuery: api.list,
  useInteractionQuery: api.detail,
  useWorkspaceDetailsQuery: api.workspace,
}))
vi.mock('../../shared/api/userApprovals', () => ({
  useUserInteractionQuery: userApi.detail,
  useUserInteractionResponse: userApi.response,
}))
vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return { Link: ({ children }: { children: import('react').ReactNode }) => React.createElement('a', { href: '/workflow' }, children) }
})

const base = NATIVE_INTERACTION_FIXTURES.codex
const humanA: DurableInteraction = { ...base, id: 'human-a', requestingAgentId: 'agent-a', approval: { handler: 'user' } }
const humanB: DurableInteraction = { ...base, id: 'human-b', requestingAgentId: 'agent-b', approval: { handler: 'user' }, request: { path: '/tmp/file', permission: 'write' } }
const orchestrator: DurableInteraction = { ...base, id: 'agent-review', requestingAgentId: 'agent-c', approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-o' } }
const queue = (items: DurableInteraction[]) => ({
  data: { pages: [{ items, nextCursor: null }] }, isPending: false, isError: false, isFetching: false,
  refetch: vi.fn(), hasNextPage: false, isFetchingNextPage: false, isFetchNextPageError: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  useApprovalInboxStore.setState({ open: false, workspaceId: '', workflowId: undefined })
  api.list.mockReturnValue(queue([humanA, humanB, orchestrator]))
  api.workspace.mockReturnValue({ data: { workspace: { id: base.workspaceId, name: 'Workspace' }, workflows: [{ id: base.workflowId, name: 'Workflow' }], agents: [
    { id: 'agent-a', name: 'Builder', role: 'Coder', harness: 'codex', model: 'gpt-5', status: 'waiting', description: 'Builds the implementation.' },
    { id: 'agent-b', name: 'Tester' }, { id: 'agent-c', name: 'Orchestrator worker' },
  ] }, isError: false })
  api.detail.mockImplementation((id: string) => ({ data: { interaction: id === humanB.id ? humanB : humanA, canRespond: true }, isPending: false, isError: false, isFetching: false, refetch: vi.fn() }))
  userApi.detail.mockReturnValue({ data: { interaction: humanA, canRespond: true }, isPending: false, isError: false, refetch: vi.fn() })
  userApi.response.mockReturnValue({ mutate: userApi.mutate, isPending: false, isError: false })
})
afterEach(cleanup)

describe('floating human approval inbox', () => {
  it('stays on the board, shows all pending human requests, and exposes profile details on the avatar', async () => {
    const user = userEvent.setup()
    useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId, workflowId: base.workflowId })
    render(<ApprovalInbox />)
    const panel = screen.getByRole('dialog', { name: 'Human approval inbox' })
    const builder = within(panel).getByRole('button', { name: 'Agent profile: Builder' })
    expect(builder).toBeVisible()
    expect(within(panel).getByRole('button', { name: 'Agent profile: Tester' })).toBeVisible()
    expect(within(panel).queryByText('Orchestrator worker')).not.toBeInTheDocument()
    expect(api.list).toHaveBeenCalledWith({ workspaceId: base.workspaceId, workflowId: base.workflowId, status: 'pending', limit: 100 }, true)
    expect(within(panel).queryByRole('button', { name: /Refresh/ })).not.toBeInTheDocument()
    const profile = document.getElementById(builder.getAttribute('aria-describedby')!)!
    expect(profile).toHaveTextContent('Coder · Codex · gpt-5')
    expect(profile).toHaveTextContent('Builds the implementation.')
    await user.click(builder)
    expect(screen.queryByRole('dialog', { name: 'Builder' })).not.toBeInTheDocument()
    expect(useApprovalInboxStore.getState().open).toBe(true)
  })

  it('offers request-scoped quick approval and the native reject choice on the left of each row', async () => {
    const user = userEvent.setup()
    useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId })
    render(<ApprovalInbox />)
    const row = screen.getAllByText('Run a command')[0]!.closest('li')!
    await user.click(within(row).getByRole('button', { name: 'Accept' }))
    expect(userApi.mutate).toHaveBeenCalledWith({ interactionId: humanA.id, optionId: 'codex-approve-once', expectedRevision: humanA.revision }, expect.any(Object))
    expect(within(row).getByRole('button', { name: 'Reject' })).toHaveAttribute('title', expect.stringContaining('This request only'))
    expect(within(row).queryByText('/project')).not.toBeInTheDocument()
  })

  it('keeps the request label inert and exposes command details from the exclamation control', () => {
    useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId })
    render(<ApprovalInbox />)
    expect(screen.getAllByText('Run a command')[0]!.tagName).toBe('SPAN')
    const info = screen.getAllByRole('button', { name: 'More details: Run a command' })[0]!
    expect(document.getElementById(info.getAttribute('aria-describedby')!)).toHaveTextContent('pnpm test')
    expect(screen.queryByRole('dialog', { name: 'Run a command' })).not.toBeInTheDocument()
  })
  it('shows the correlated target and proposed change in current request details', () => {
    api.list.mockReturnValue(queue([{ ...humanA, reviewContext: {
      target: '/project/src/app.ts', changeSummary: 'Change two lines in the startup handler.',
    } }]))
    useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId })
    render(<ApprovalInbox />)
    const info = screen.getByRole('button', { name: 'More details: Run a command' })
    const details = document.getElementById(info.getAttribute('aria-describedby')!)!
    expect(details).toHaveTextContent('Target: /project/src/app.ts')
    expect(details).toHaveTextContent('Proposed change: Change two lines in the startup handler.')
    expect(details).toHaveTextContent('pnpm test')
  })

})

it('keeps a historical retired request visible without Accept or Reject actions', () => {
  api.list.mockReturnValue(queue([{ ...humanA, harness: 'opencode' }]))
  useApprovalInboxStore.getState().openInbox({ workspaceId: base.workspaceId, workflowId: base.workflowId })
  render(<ApprovalInbox />)
  expect(screen.getByText('Retired harness (OpenCode): read-only')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  expect(userApi.mutate).not.toHaveBeenCalled()
})
