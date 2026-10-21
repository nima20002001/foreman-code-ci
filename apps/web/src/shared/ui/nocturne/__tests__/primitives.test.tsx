import '@testing-library/jest-dom/vitest'
import { createRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button, IconButton, LinkButton, TextField, Select, Switch, RadioGroup, Slider, Tabs, SegmentedControl, Progress, DataTable, WorkflowNodeCard, ApprovalCard, RunControls, SaveBar, ToastProvider, useToast } from '..'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Nocturne primitives', () => {
  it('does not submit a surrounding form by default', async () => {
    const submit = vi.fn((event) => event.preventDefault())
    render(<form onSubmit={submit}><Button>Open details</Button></form>)
    await userEvent.click(screen.getByRole('button', { name: 'Open details' }))
    expect(submit).not.toHaveBeenCalled()
  })
  it('allows an explicit submit button', async () => {
    const submit = vi.fn((event) => event.preventDefault())
    render(<form onSubmit={submit}><Button type="submit">Save</Button></form>)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(submit).toHaveBeenCalledOnce()
  })
  it('blocks duplicate clicks while loading and retains an accessible label', async () => {
    const click = vi.fn()
    render(<Button loading loadingLabel="Saving changes" onClick={click}>Save</Button>)
    const button = screen.getByRole('button', { name: 'Saving changes' })
    expect(button).toBeDisabled(); expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button); expect(click).not.toHaveBeenCalled()
  })
  it('names icon-only buttons', () => {
    render(<IconButton label="Close inspector"><span aria-hidden="true">×</span></IconButton>)
    expect(screen.getByRole('button', { name: 'Close inspector' })).toBeVisible()
  })
  it('passes React 19 refs to the native controls', () => {
    const input = createRef<HTMLInputElement>(); const button = createRef<HTMLButtonElement>()
    render(<><TextField label="Name" ref={input} /><Button ref={button}>Focus target</Button></>)
    expect(input.current).toBe(screen.getByLabelText('Name'))
    expect(button.current).toBe(screen.getByRole('button', { name: 'Focus target' }))
  })
  it('protects links opened in a new tab without dropping caller relations', () => {
    render(<LinkButton href="/docs" target="_blank" rel="help">Documentation</LinkButton>)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('rel', 'help noopener noreferrer')
  })
  it('connects labels, hints, caller descriptions and errors without duplicate IDs', () => {
    render(<><p id="extra">Extra context</p><TextField label="First" hint="First hint" error="Required" aria-describedby="extra" /><TextField label="Second" hint="Second hint" /></>)
    const first = screen.getByLabelText('First'); const second = screen.getByLabelText('Second')
    expect(first.id).not.toBe(second.id); expect(first).toHaveAttribute('aria-invalid', 'true')
    expect(first).toHaveAccessibleDescription('Extra context First hint Required')
    expect(second).toHaveAccessibleDescription('Second hint')
  })
  it('uses native disabled options', () => {
    render(<Select label="Location" options={[{ value: 'local', label: 'Local' }, { value: 'remote', label: 'Remote', disabled: true }]} />)
    expect(screen.getByRole('option', { name: 'Remote' })).toBeDisabled()
  })
  it('uses a native switch input with a visible name', async () => {
    render(<Switch label="Notifications" defaultChecked />)
    const toggle = screen.getByRole('switch', { name: 'Notifications' }); expect(toggle).toBeChecked()
    await userEvent.click(toggle); expect(toggle).not.toBeChecked()
  })
  it('does not share radio-group names across component instances', () => {
    const props = { label: 'Access', value: 'read', options: [{ value: 'read', label: 'Read only' }], onValueChange: vi.fn() }
    render(<><RadioGroup {...props} /><RadioGroup {...props} /></>)
    const inputs = screen.getAllByRole('radio')
    expect(inputs[0].getAttribute('name')).not.toBe(inputs[1].getAttribute('name'))
  })
  it('clamps invalid range inputs', () => {
    render(<Slider label="Concurrency" min={1} max={8} value={Infinity} onValueChange={vi.fn()} />)
    expect(screen.getByRole('slider')).toHaveValue('1')
  })
  it('renders indeterminate progress without a value attribute', () => {
    render(<Progress label="Loading progress" />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
  })
  it('clamps out-of-range progress', () => {
    render(<Progress label="Run progress" value={999} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '100')
  })
})

describe('Controlled navigation and safe states', () => {
  function TabsExample() {
    const [value, setValue] = useState('one')
    return <Tabs label="Views" value={value} onValueChange={setValue} items={[{ value: 'one', label: 'One', content: 'First view' }, { value: 'disabled', label: 'Disabled', content: 'Unavailable', disabled: true }, { value: 'three', label: 'Three', content: 'Third view' }]} />
  }
  it('uses arrow keys and skips disabled tabs', async () => {
    render(<TabsExample />)
    screen.getByRole('tab', { name: 'One' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Third view')
    await userEvent.keyboard('{Home}'); expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus()
  })
  it('supports RTL tab navigation', () => {
    render(<div dir="rtl"><TabsExample /></div>)
    const nativeStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = nativeStyle(element)
      return new Proxy(style, { get: (target, key) => key === 'direction' ? 'rtl' : Reflect.get(target, key) })
    })
    screen.getByRole('tab', { name: 'One' }).focus()
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus()
  })
  it('keeps inactive panels mounted to preserve a local form draft', async () => {
    function Example() { const [value, setValue] = useState('form'); return <Tabs label="Draft views" value={value} onValueChange={setValue} items={[{ value: 'form', label: 'Form', content: <TextField label="Draft" /> }, { value: 'other', label: 'Other', content: 'Other' }]} /> }
    render(<Example />); await userEvent.type(screen.getByLabelText('Draft'), 'Keep me')
    await userEvent.click(screen.getByRole('tab', { name: 'Other' })); await userEvent.click(screen.getByRole('tab', { name: 'Form' }))
    expect(screen.getByLabelText('Draft')).toHaveValue('Keep me')
  })
  it('uses grouped native radios for segmented controls', () => {
    render(<SegmentedControl label="Layout" value="graph" options={[{ value: 'graph', label: 'Graph' }, { value: 'list', label: 'List' }]} onValueChange={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Layout' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Graph' })).toBeChecked()
  })
  it('keeps table sorting controlled and exposes aria-sort', async () => {
    const sort = vi.fn()
    render(<DataTable label="Runs" rows={[{ id: '1' }]} rowKey={(row) => row.id} columns={[{ id: 'id', header: 'Run', sortable: true, render: (row) => row.id }]} sort={{ column: 'id', direction: 'asc' }} onSortChange={sort} />)
    expect(screen.getByRole('columnheader')).toHaveAttribute('aria-sort', 'ascending')
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(sort).toHaveBeenCalledWith({ column: 'id', direction: 'desc' })
  })
  it('renders graph nodes as actual accessible buttons', () => {
    render(<WorkflowNodeCard title="Builder" subtitle="Codex" statusLabel="Working" selected onSelect={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Builder: Working' })).toHaveAttribute('aria-pressed', 'true')
  })
  it('marks harness identity on graph nodes only when it is known', () => {
    render(<><WorkflowNodeCard title="Builder" subtitle="Codex" statusLabel="Idle" harness="codex" onSelect={vi.fn()} />
      <WorkflowNodeCard title="Planner" subtitle="Agent" statusLabel="Idle" onSelect={vi.fn()} /></>)
    expect(screen.getByRole('button', { name: 'Builder: Idle' })).toHaveAttribute('data-harness', 'codex')
    expect(screen.getByRole('button', { name: 'Planner: Idle' })).not.toHaveAttribute('data-harness')
  })
  it('defaults approval decisions to read-only', async () => {
    const choose = vi.fn()
    render(<ApprovalCard title="Approve command" description="Run a test" scope="This run only" choices={[{ id: 'allow', label: 'Allow once' }]} onChoose={choose} />)
    const button = screen.getByRole('button', { name: 'Allow once' }); expect(button).toBeDisabled()
    await userEvent.click(button); expect(choose).not.toHaveBeenCalled()
  })
  it('forwards the exact approval choice identity', async () => {
    const choose = vi.fn()
    render(<ApprovalCard title="Request" description="Inspect" scope="Exact scope" canRespond choices={[{ id: 'opaque-native-choice', label: 'Continue once' }]} onChoose={choose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Continue once' }))
    expect(choose).toHaveBeenCalledWith('opaque-native-choice')
  })
  it('disables all pending decisions and does not suggest success', () => {
    render(<ApprovalCard title="Request" description="Inspect" scope="This run" canRespond pending error="Delivery failed." choices={[{ id: 'a', label: 'Allow' }, { id: 'b', label: 'Deny' }]} onChoose={vi.fn()} />)
    screen.getAllByRole('button').forEach((button) => expect(button).toBeDisabled())
    expect(screen.getByRole('alert')).toHaveTextContent('Your decision has not been confirmed.')
  })
  it('removes decisions after resolution, including denied requests', () => {
    render(<ApprovalCard title="Request" description="Inspect" scope="This run" resolvedLabel="Denied" choices={[{ id: 'a', label: 'Allow' }]} onChoose={vi.fn()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('Denied')).toHaveAttribute('data-tone', 'neutral')
  })
  it('shows a caller-provided reason for unavailable approvals', () => {
    render(<ApprovalCard title="Request" description="Inspect" scope="This run" unavailableReason="Reconnect before responding." choices={[]} onChoose={vi.fn()} />)
    expect(screen.getByText('Reconnect before responding.')).toBeVisible()
  })
  it('does not invent run actions without handlers', () => {
    render(<RunControls />); expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
  it('blocks saving conflicting drafts without removing the discard action', () => {
    render(<SaveBar dirty conflict="Reload the current version before saving." onSave={vi.fn()} onDiscard={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled()
  })
  it('keeps notifications until explicit dismissal', async () => {
    function Trigger() { const { notify } = useToast(); return <Button onClick={() => notify({ title: 'Saved', description: 'Your changes are safe.' })}>Notify</Button> }
    render(<ToastProvider><Trigger /></ToastProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'Notify' }))
    const region = screen.getByRole('list', { name: 'Notifications' })
    expect(within(region).getByText('Saved')).toBeVisible()
    await userEvent.click(within(region).getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })
})
