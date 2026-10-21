import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import type { Agent } from '@foreman-code/contracts'

import { AgentsDirectoryContent } from './AgentsDirectory'
import { useAgentDirectoryStore } from './agentDirectoryStore'

const agents: Agent[] = [
  {
    id: 'agent-researcher',
    name: 'Researcher',
    role: 'researcher',
    description: 'Finds and summarizes source material.',
    executionState: 'available',
    model: 'gpt-test',
  },
  {
    id: 'agent-builder',
    name: 'Builder',
    role: 'builder',
    executionState: 'available',
    model: 'gpt-test',
  },
]

afterEach(() => {
  sessionStorage.clear()
  useAgentDirectoryStore.getState().reset()
})

describe('AgentsDirectoryContent', () => {
  it('renders persisted agents without a local creation path', () => {
    render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)

    expect(screen.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeVisible()
    expect(screen.getByLabelText('Researcher, researcher, Available')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Add agent' })).not.toBeInTheDocument()
  })

  it('directs empty workspaces to create agents through a workflow graph', () => {
    render(<AgentsDirectoryContent workspaceId="workspace-empty" agents={[]} />)

    expect(screen.getByText('No agents yet')).toBeVisible()
    expect(screen.getByText(/Add agents from a workflow graph/)).toBeVisible()
  })

  it('keeps accessible card reordering as local interaction state only', async () => {
    const user = userEvent.setup()
    render(<AgentsDirectoryContent workspaceId="workspace-1" agents={agents} />)
    const researcher = screen.getByLabelText('Researcher, researcher, Available')

    researcher.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')

    const cards = [...document.querySelectorAll<HTMLElement>('[data-agent-id]')]
    expect(cards.map((card) => card.dataset.agentId)).toEqual(['agent-builder', 'agent-researcher'])
    expect(screen.getByRole('status')).toHaveTextContent('Moved Researcher')
  })
})
