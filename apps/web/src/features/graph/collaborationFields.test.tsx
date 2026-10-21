// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { memoryBoardTools, newAgentGraphqlTools, type GraphqlAgentTool } from '@foreman-code/contracts'
import { WorkflowBoardContext } from '../workflow-board/context'
import { GraphqlToolsFields } from './GraphqlToolsFields'
import { NodeWorkflowFields } from './nextDraft/AuthoringFields'
import { fixture } from './nextDraft/core.cases'
import type { CollaborationFieldSlots } from './collaborationFields'
import { CollaborationUIProvider } from '../../shared/ui/collaborationSlots'

afterEach(cleanup)
function FieldsFixture() {
  const context = fixture(), [graph, setGraph] = useState(context.draft.graph)
  const node = graph.nodes[0]!
  const [tools, setTools] = useState<GraphqlAgentTool[]>(['context_get'])
  const fields: CollaborationFieldSlots = {
    memoryAccess: props => <section aria-label="Injected Memory access">
      <p>{props.role} · {props.executionReadOnly ? 'Effective read-only execution' : 'Writable execution'}</p>
      <button onClick={() => props.onChange([...(props.defaults ?? []), ...memoryBoardTools('read')], props.override)}>Use memory Read</button>
    </section>,
    nodeBrowser: props => <section aria-label="Injected Browser settings">
      <p>{props.workspaceId}/{props.workflowId}/{props.nodeId} · {props.value?.enabled ? 'On' : 'Off'}</p>
      <button onClick={() => props.onChange({ enabled: true, profileId: 'chosen-profile' })}>Use chosen browser</button>
    </section>,
  }
  return <WorkflowBoardContext.Provider value={{ workspaceId: 'workspace', workflowId: 'workflow',
    inspection: {}, selectInspection: () => undefined, selectRun: () => undefined,
    openLocation: () => undefined, openRuns: () => undefined, activeRuns: 0, collaborationFields: fields }}>
    <GraphqlToolsFields role="coder" defaults={tools} override={undefined} executionReadOnly
      onChange={value => setTools(value ?? [])} />
    <NodeWorkflowFields graph={graph} node={node} context={context} change={setGraph} />
    <output aria-label="Selected tools">{tools.join(', ')}</output>
    <output aria-label="Browser tools">{JSON.stringify(node.kind !== 'job' ? node.graphqlTools : null)}</output>
    <output aria-label="Browser draft">{JSON.stringify(node.kind !== 'job' ? node.browser : null)}</output>
  </WorkflowBoardContext.Provider>
}
it('mounts feature-owned controls on the ordinary tool and node draft values without a separate save', async () => {
  render(<FieldsFixture />)
  expect(screen.getByRole('region', { name: 'Injected Memory access' })).toHaveTextContent('coder · Effective read-only execution')
  expect(screen.getByRole('region', { name: 'Injected Browser settings' })).toHaveTextContent('workspace/workflow/node-0 · Off')
  await userEvent.click(screen.getByRole('button', { name: 'Use memory Read' }))
  expect(screen.getByLabelText('Selected tools')).toHaveTextContent('context_get, memory_board_get, memory_board_changes_read')
  await userEvent.click(screen.getByRole('button', { name: 'Use chosen browser' }))
  expect(screen.getByLabelText('Browser tools')).toHaveTextContent('browser_state_read')
  expect(screen.getByLabelText('Browser tools')).toHaveTextContent('browser_action')
  expect(screen.getByLabelText('Browser draft')).toHaveTextContent('{"enabled":true,"profileId":"chosen-profile"}')
})

it('mounts the same injected Memory access field in standalone Agent settings outside a Board', () => {
  render(<CollaborationUIProvider value={{ memoryAccess: props => <p>Standalone {props.role} Memory access</p> }}>
    <GraphqlToolsFields role="orchestrator" defaults={undefined} override={undefined} onChange={() => undefined} />
  </CollaborationUIProvider>)
  expect(screen.getByText('Standalone orchestrator Memory access')).toBeVisible()
})

it('keeps an explicit browser tool Off choice even when Agent defaults omit browser tools', async () => {
  const changed = vi.fn()
  render(<CollaborationUIProvider value={{ nodeBrowser: () => null }}>
    <GraphqlToolsFields role="coder" defaults={newAgentGraphqlTools('coder')}
      override={{ add: ['browser_action'], remove: [] }} onChange={changed} />
  </CollaborationUIProvider>)
  const choice = within(screen.getByRole('group', { name: 'Act on page: this workflow' })).getByRole('radio', { name: 'Off' })
  expect(choice).toBeEnabled()
  await userEvent.click(choice)
  expect(changed).toHaveBeenCalledWith(newAgentGraphqlTools('coder'), { add: [], remove: ['browser_action'] })
})
