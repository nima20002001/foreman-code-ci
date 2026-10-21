import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  BudgetMeter, ExecutionMap, ExecutionTimeline, FailureRecovery, FileDropzone, FilterChips,
  MotionControl, MultiSelect, NotificationCenter, PermissionMatrix, ReplayControls, useReplay,
  type ExecutionNode,
} from '..'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
const nodes: ExecutionNode[] = [
  { id: 'builder', title: 'Builder', subtitle: 'Codex', statusLabel: 'Working', x: 0, y: 0 },
  { id: 'reviewer', title: 'Reviewer', subtitle: 'Claude', statusLabel: 'Waiting', x: 300, y: 0 },
]
describe('Execution visualization and replay', () => {
  it('provides a useful empty graph state', () => {
    render(<ExecutionMap nodes={[]} connections={[]} onSelect={vi.fn()} />)
    expect(screen.getByText('No agents in this workflow')).toBeVisible()
  })
  it('preserves selection and exact agent identity in list view', async () => {
    const select = vi.fn()
    render(<ExecutionMap nodes={nodes} connections={[]} selectedId="reviewer" layout="list" onSelect={select} />)
    expect(screen.getByRole('button', { name: 'Reviewer: Waiting' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Builder: Working' }))
    expect(select).toHaveBeenCalledWith('builder')
  })
  it('does not draw a connection whose endpoint is missing', () => {
    const { container } = render(<ExecutionMap nodes={nodes} connections={[{ id: 'missing', from: 'builder', to: 'unknown', label: 'Unresolved', state: 'idle' }]} onSelect={vi.fn()} />)
    expect(container.querySelectorAll('.n-flow-connection')).toHaveLength(0)
    expect(screen.getByText(/unknown: Unresolved/)).toBeVisible()
  })
  it('starts visual motion only when explicitly enabled', () => {
    const { container } = render(<ExecutionMap nodes={nodes} connections={[]} onSelect={vi.fn()} />)
    expect(container.querySelector('.n-execution-map')).toHaveAttribute('data-motion', 'off')
  })
  it('keeps unknown measurements unknown, without a progress bar', () => {
    render(<BudgetMeter label="Provider cost" used={1} />)
    expect(screen.getByText('Not available')).toBeVisible()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
  it('shows the actual exceeded limit while clamping the visual fill', () => {
    render(<BudgetMeter label="Tokens" used={150} limit={100} />)
    expect(screen.getByText('150 / 100')).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '100')
  })
  it('locks all replay actions for an empty history', () => {
    render(<ReplayControls index={999} count={0} playing={false} onPlayingChange={vi.fn()} onSeek={vi.fn()} />)
    screen.getAllByRole('button').forEach(button => expect(button).toBeDisabled())
    expect(screen.getByRole('slider')).toBeDisabled()
  })
  it('pauses when seeking and bounds the previous event', async () => {
    const play = vi.fn(), seek = vi.fn()
    render(<ReplayControls index={1} count={3} playing onPlayingChange={play} onSeek={seek} />)
    await userEvent.click(screen.getByRole('button', { name: 'Previous event' }))
    expect(play).toHaveBeenCalledWith(false); expect(seek).toHaveBeenCalledWith(0)
  })
  it('restarts at zero when playing a completed replay', async () => {
    const play = vi.fn(), seek = vi.fn()
    render(<ReplayControls index={2} count={3} playing={false} onPlayingChange={play} onSeek={seek} />)
    await userEvent.click(screen.getByRole('button', { name: 'Play replay' }))
    expect(seek).toHaveBeenCalledWith(0); expect(play).toHaveBeenCalledWith(true)
  })
  it('preserves caller-supplied event order and identities', async () => {
    const select = vi.fn()
    render(<ExecutionTimeline events={[{ id: 'z', title: 'First', time: '02:00' }, { id: 'a', title: 'Second', time: '01:00' }]} onSelect={select} />)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['First', 'Second'])
    await userEvent.click(screen.getByRole('button', { name: 'Second' })); expect(select).toHaveBeenCalledWith('a')
  })
  it('lets the system reduced-motion preference disable visual motion', () => {
    render(<MotionControl enabled systemReduced onEnabledChange={vi.fn()} />)
    const control = screen.getByRole('switch', { name: /Connection animation/ })
    expect(control).toBeDisabled(); expect(control).not.toBeChecked()
  })
  it('never offers an unavailable retry action as enabled', () => {
    render(<FailureRecovery title="Failed" description="Read the result" unavailableReason="Permission required" onRetry={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled()
  })
  it('cancels the replay timer as soon as the document is hidden', () => {
    vi.useFakeTimers(); let hidden = false
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const seek = vi.fn(), play = vi.fn()
    renderHook(() => useReplay({ index: 0, count: 3, playing: true, onSeek: seek, onPlayingChange: play }))
    act(() => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(3000) })
    expect(play).toHaveBeenCalledWith(false); expect(seek).not.toHaveBeenCalled()
  })
  it('advances by one supplied event and clears timers when unmounted', () => {
    vi.useFakeTimers(); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const seek = vi.fn()
    const { unmount } = renderHook(() => useReplay({ index: 0, count: 3, playing: true, speed: 2, onSeek: seek, onPlayingChange: vi.fn() }))
    act(() => { vi.advanceTimersByTime(1000) }); expect(seek).toHaveBeenCalledWith(1)
    unmount(); act(() => { vi.advanceTimersByTime(10000) }); expect(seek).toHaveBeenCalledOnce()
  })
})
describe('Workspace patterns', () => {
  it('defaults effective permissions to a read-only projection', () => {
    render(<PermissionMatrix rows={[{ id: 'write', resource: 'Write files', scope: 'Workspace', allowed: false }]} onChange={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByText('Not allowed')).toBeVisible()
  })
  it('keeps locked permissions disabled even for an editable matrix', () => {
    render(<PermissionMatrix canEdit rows={[{ id: 'write', resource: 'Write files', scope: 'Workspace', allowed: false, locked: true }]} onChange={vi.fn()} />)
    expect(screen.getByRole('checkbox', { name: 'Write files' })).toBeDisabled()
  })
  it('keeps selections when searching and preserves unavailable choices', async () => {
    function Choices() { const [values, setValues] = useState(['read']); return <MultiSelect label="Tools" values={values} onValuesChange={setValues} options={[{ value: 'read', label: 'Read' }, { value: 'edit', label: 'Edit' }, { value: 'network', label: 'Network', disabled: true }]} /> }
    render(<Choices />); await userEvent.click(screen.getByRole('checkbox', { name: 'Edit' }))
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search tools' }), 'network')
    expect(screen.getByText('2 selected')).toBeVisible(); expect(screen.getByRole('checkbox', { name: 'Network' })).toBeDisabled()
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search tools' }))
    expect(screen.getByRole('checkbox', { name: 'Read' })).toBeChecked(); expect(screen.getByRole('checkbox', { name: 'Edit' })).toBeChecked()
  })
  it('reports file-selection errors without forwarding invalid files', () => {
    const files = vi.fn(); render(<FileDropzone onFiles={files} maxBytes={3} />)
    fireEvent.change(screen.getByLabelText('Add context files'), { target: { files: [new File(['too large'], 'context.md', { type: 'text/markdown' })] } })
    expect(files).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('exceeds the size limit')
  })
  it('forwards valid selected files once and resets the input', () => {
    const files = vi.fn(); const file = new File(['ok'], 'context.md', { type: 'text/markdown' })
    render(<FileDropzone onFiles={files} />)
    fireEvent.change(screen.getByLabelText('Add context files'), { target: { files: [file] } })
    expect(files).toHaveBeenCalledWith([file]); expect(screen.getByLabelText('Add context files')).toHaveValue('')
  })
  it('does not accept a dropped file into a disabled picker', () => {
    const files = vi.fn(); const { container } = render(<FileDropzone disabled onFiles={files} />)
    fireEvent.drop(container.querySelector('.n-dropzone')!, { dataTransfer: { files: [new File(['ok'], 'context.md')] } })
    expect(files).not.toHaveBeenCalled()
  })
  it('removes the exact requested filter', async () => {
    const remove = vi.fn(); render(<FilterChips filters={[{ id: 'opaque-filter', label: 'Active' }]} onRemove={remove} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter: Active' }))
    expect(remove).toHaveBeenCalledWith('opaque-filter')
  })
  it('reports notification reads using the supplied identity', async () => {
    const read = vi.fn(); render(<NotificationCenter items={[{ id: 'notice-1', title: 'Approval needed', description: 'Scoped command', time: 'Now', unread: true }]} onRead={read} />)
    await userEvent.click(screen.getByRole('button', { name: 'Mark as read: Approval needed' }))
    expect(read).toHaveBeenCalledWith('notice-1')
  })
})
