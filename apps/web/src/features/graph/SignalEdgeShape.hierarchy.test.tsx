// @vitest-environment jsdom
import { ReactFlowProvider } from '@xyflow/react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { SignalEdgeShape } from './SignalEdgeShape'

afterEach(cleanup)
const curve = { path: 'M 0,0 Q 100,100 200,0', mid: { x: 100, y: 50, angle: 0 } }
it('explains the reporting direction with visible text and keeps ordinary and approval routes distinct', async () => {
  const view = render(<ReactFlowProvider><svg><SignalEdgeShape id="parent-route" curve={curve}
    kind="execution" reportingParent="Project lead" /></svg></ReactFlowProvider>)
  expect(screen.getByText('Orchestrates')).toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About Reporting to Project lead' }))
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Tasks go down; reports return to Project lead.')
  view.rerender(<ReactFlowProvider><svg><SignalEdgeShape id="approval-route" curve={curve} kind="approval" /></svg></ReactFlowProvider>)
  expect(screen.queryByText('Orchestrates')).not.toBeInTheDocument()
  view.rerender(<ReactFlowProvider><svg><SignalEdgeShape id="ordinary-route" curve={curve} kind="execution" /></svg></ReactFlowProvider>)
  expect(screen.queryByText('Orchestrates')).not.toBeInTheDocument()
})
