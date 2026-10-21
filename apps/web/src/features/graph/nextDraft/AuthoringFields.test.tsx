import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { ApprovalFields, ChoiceFields, EntryFields, NodeConnections, NodeWorkflowFields, RelationshipFields } from './AuthoringFields'
import { fixture } from './core.cases'
import { putRelationship } from './model'

function Form({ revision = 7 }: { revision?: number }) {
  const context = fixture(['orchestrator', 'coder'])
  context.draft.revision = revision
  const [graph, setGraph] = useState(context.draft.graph)
  return <><EntryFields graph={graph} context={context} change={setGraph} />
    <NodeWorkflowFields graph={graph} node={graph.nodes.find((node) => node.id === 'node-0')!} context={context} change={setGraph} />
    <output data-testid="entry">{graph.entryNodeId}</output></>
}

describe('Agent 6 accessible authoring forms (not browser performance evidence)', () => {
  it('entry control is keyboard focusable and the node switch mirrors it', async () => {
    const user = userEvent.setup()
    render(<Form />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'About Starts the workflow' })).toHaveFocus()
    expect(screen.getByRole('tooltip')).toHaveTextContent('Only an Orchestrator can start a workflow that has one.')
    await user.tab()
    expect(screen.getByLabelText('Starts the workflow', { selector: 'select' })).toHaveFocus()
    expect(screen.getByRole('switch', { name: /Starts the workflow/ })).toBeChecked()
    await user.click(screen.getByRole('switch', { name: /Starts the workflow/ }))
    expect(screen.getByTestId('entry')).toBeEmptyDOMElement()
  })
  it('choice creation leaves an unresolved target until explicit branch-end selection', async () => {
    const user = userEvent.setup()
    function ChoiceForm() {
      const [graph, setGraph] = useState(fixture().draft.graph)
      return <><ChoiceFields graph={graph} node={graph.nodes[0]!} change={setGraph} /><output data-testid="choice">{JSON.stringify(graph.nodes[0]!.choice)}</output></>
    }
    render(<ChoiceForm />)
    await user.selectOptions(screen.getByLabelText('Routing mode'), 'choice')
    await user.click(screen.getByRole('button', { name: 'Add outcome' }))
    expect(screen.getByLabelText('Target for outcome 1')).toHaveValue('edge:')
    await user.type(screen.getByLabelText('Outcome 1'), 'finished')
    await user.selectOptions(screen.getByLabelText('Target for outcome 1'), 'end')
    expect(screen.getByTestId('choice')).toHaveTextContent('branch_end')
    expect(screen.getByText(/Return exactly this JSON/)).toBeInTheDocument()
  })
  it('form action deletes only the chosen semantic record', async () => {
    const user = userEvent.setup(), report = vi.fn()
    function Relationships() {
      const [graph, setGraph] = useState<WorkflowDefinitionV3>(() => putRelationship(fixture().draft.graph,
        { id: 'approval', source: 'node-0', target: 'node-1', kind: 'approval' }))
      const relationship = graph.edges.find((edge) => edge.id === 'approval')
      return <>{relationship ? <RelationshipFields graph={graph} relationship={relationship} change={setGraph} report={report} /> : null}
        <output data-testid="relationships">{graph.edges.map((edge) => edge.id).join(',')}</output></>
    }
    render(<Relationships />)
    await user.click(screen.getByRole('button', { name: 'Remove connection' }))
    expect(screen.getByTestId('relationships')).toHaveTextContent('execution-1')
    expect(screen.getByTestId('relationships')).not.toHaveTextContent('approval')
    expect(report).not.toHaveBeenCalled()
  })
  it('lists and removes one agent’s connections and adds one by keyboard', async () => {
    const user = userEvent.setup(), report = vi.fn()
    function Connections() {
      const [graph, setGraph] = useState<WorkflowDefinitionV3>(() => fixture(['orchestrator', 'coder']).draft.graph)
      return <><NodeConnections graph={graph} nodeId="node-0" change={setGraph} report={report} />
        <output data-testid="relationships">{graph.edges.map((edge) => `${edge.kind}:${edge.source}>${edge.target}`).join(',')}</output></>
    }
    render(<Connections />)
    await user.click(screen.getByRole('radio', { name: 'Approval' }))
    await user.selectOptions(screen.getByLabelText('Reviews'), 'node-1')
    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(screen.getByTestId('relationships')).toHaveTextContent('approval:node-0>node-1')
    await user.click(screen.getByRole('button', { name: /Remove connection: Hands off/ }))
    expect(screen.getByTestId('relationships')).not.toHaveTextContent('execution')
    expect(report).not.toHaveBeenCalled()
  })
  it('switching to Human cannot silently prune existing App assignments', async () => {
    const user = userEvent.setup(), report = vi.fn(), context = fixture(['orchestrator', 'coder'])
    let graph = putRelationship(context.draft.graph, { id: 'approval', source: 'node-0', target: 'node-1', kind: 'approval' })
    graph = { ...graph, approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-0' } }
    const change = vi.fn((update: (value: WorkflowDefinitionV3) => WorkflowDefinitionV3) => { graph = update(graph) })
    render(<ApprovalFields graph={graph} context={context} change={change} report={report} />)
    await user.selectOptions(screen.getByLabelText('Approval handler'), 'user')
    expect(report).toHaveBeenCalledOnce()
    expect(graph.edges.map((edge) => edge.id)).toEqual(['execution-1', 'approval'])
    expect(graph.approval!.handler).toBe('orchestrator')
  })
  it('shows reviewing orchestrator guidance only through its label hint', async () => {
    const user = userEvent.setup()
    const context = fixture(['orchestrator', 'coder'])
    const graph: WorkflowDefinitionV3 = { ...context.draft.graph,
      approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-0' } }
    render(<ApprovalFields graph={graph} context={context} change={vi.fn()} report={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Reviewing coordinator' })).toHaveValue('agent-0')
    const explanation = 'The starting Master or Orchestrator reviews requests from agents it has an approval connection to.'
    expect(screen.queryByText(explanation)).not.toBeInTheDocument()
    const hint = screen.getByRole('button', { name: 'About Reviewing coordinator' })
    await user.hover(hint)
    expect(screen.getByRole('tooltip')).toHaveTextContent(explanation)
    expect(hint).toHaveAccessibleDescription(explanation)
  })
  it('selects explicit native handling without changing Agent settings or execution routes', async () => {
    const user = userEvent.setup()
    const context = fixture()
    const before = structuredClone(context)
    const report = vi.fn()
    function NativeApprovalForm() {
      const [graph, setGraph] = useState(context.draft.graph)
      return <><ApprovalFields graph={graph} context={context} change={setGraph} report={report} />
        <output data-testid="approval-mode">{graph.approval?.handler}</output>
        <output data-testid="routes">{JSON.stringify(graph.edges)}</output></>
    }
    render(<NativeApprovalForm />)
    await user.selectOptions(screen.getByLabelText('Approval handler'), 'native')
    expect(screen.getByTestId('approval-mode')).toHaveTextContent('native')
    expect(screen.getByTestId('routes')).toHaveTextContent(JSON.stringify(before.draft.graph.edges))
    expect(screen.queryByText(/Each Agent must explicitly use native approval handling/)).not.toBeInTheDocument()
    await user.hover(screen.getByRole('button', { name: 'About Approval handler' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Each Agent must explicitly use native approval handling/)
    expect(context).toEqual(before)
    expect(report).not.toHaveBeenCalled()
  })
})
