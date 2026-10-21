import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionControlStateSchema } from '@foreman-code/contracts'
import { OperatorComposer } from '../../operator-chat/OperatorComposer'
import { ConversationComposer } from '../ConversationComposer'
import { SessionContext } from './SessionControls'
import type { ComposerSessionControls } from './useSessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'

const state = SessionControlStateSchema.parse({ conversationId: 'chat', revision: 1, profileKey: 'profile',
  desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
  context: null, nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [], busyReason: null,
  capabilities: { profileKey: 'profile', model: 'model', modelCapacity: 200000, contextBudgets: [], contextProfiles: [],
    compact: { supported: true, reason: null }, plan: { supported: true, reason: null },
    autoCompact: { supported: true, reason: null }, autoCompactBudget: { supported: false, reason: 'Capacity unknown' } } })
function controller() {
  return { state, query: { isError: false, refetch: vi.fn() }, mutation: { isPending: false, isError: false },
    change: vi.fn(async () => state), command: vi.fn(async () => true) } as unknown as ComposerSessionControls
}
afterEach(() => { cleanup(); useConversationDraftStore.getState().clearAllDrafts() })
for (const role of ['Operator', 'node'] as const) describe(`${role} composer native commands`, () => {
  function mount(sendDisabled = false) {
    const controls = controller()
    const send = vi.fn()
    const attachment = <button type="button">Ready attachment</button>
    if (role === 'Operator') render(<OperatorComposer conversationId="chat" sessionControls={controls}
      onNewChat={vi.fn()} onSubmit={send} attachmentControl={attachment} hasAttachments sendDisabled={sendDisabled} />)
    else render(<ConversationComposer conversationId="chat" sessionControls={controls}
      onSubmit={send} attachmentControl={attachment} hasAttachments sendDisabled={sendDisabled} />)
    return { controls, send, input: screen.getByRole('textbox', { name: 'Message' }) }
  }
  it('uses a native operation for bare commands and keeps attachments outside message submission', async () => {
    const { controls, send, input } = mount()
    fireEvent.change(input, { target: { value: '/compact' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(controls.command).toHaveBeenCalledWith('/compact', 'chat'))
    expect(send).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Ready attachment' })).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '/plan off' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(controls.command).toHaveBeenCalledWith('/plan off', 'chat'))
  })
  it('submits one Plan task through normal admission and ignores slash text elsewhere', () => {
    const { send, input } = mount()
    fireEvent.change(input, { target: { value: '/plan Inspect the repository' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith('/plan Inspect the repository', 'plan')
    fireEvent.change(input, { target: { value: 'Explain /compact' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(send).toHaveBeenLastCalledWith('Explain /compact')
  })
  it('submits a Plan task from the send button after Tab completion', () => {
    const { controls, send, input } = mount()
    fireEvent.change(input, { target: { value: '/p' } })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveValue('/plan')
    expect(controls.command).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '/plan Inspect files' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('/plan Inspect files', 'plan')
    expect(controls.command).not.toHaveBeenCalled()
  })
  it('preserves the draft on command failure and does not submit while composing IME input', async () => {
    const { controls, send, input } = mount()
    vi.mocked(controls.command).mockRejectedValue(new Error('Compaction is unconfirmed.'))
    fireEvent.change(input, { target: { value: '/compact' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(controls.command).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Compaction is unconfirmed.')
    expect(input).toHaveValue('/compact')
    expect(send).not.toHaveBeenCalled()
  })
  it.each(['/plan', '/plan off', '/compact'])('routes %s from the send button only to controls', async content => {
    const { controls, send, input } = mount(true)
    fireEvent.change(input, { target: { value: content } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(controls.command).toHaveBeenCalledExactlyOnceWith(content, 'chat'))
    expect(send).not.toHaveBeenCalled()
  })
  it.each(['/plan', '/compact'])('autocompletes %s while ordinary messages are blocked', async content => {
    const { controls, send, input } = mount(true)
    fireEvent.change(input, { target: { value: content.slice(0, 2) } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(controls.command).toHaveBeenCalledExactlyOnceWith(content, 'chat'))
    expect(send).not.toHaveBeenCalled()
  })
  it.each(['ctrlKey', 'altKey', 'metaKey', 'shiftKey'])('does not submit autocomplete on %s + Enter', modifier => {
    const { controls, send, input } = mount()
    fireEvent.change(input, { target: { value: '/p' } })
    fireEvent.keyDown(input, { key: 'Enter', [modifier]: true })
    expect(input).toHaveValue('/p')
    expect(controls.command).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it('leaves Shift + Tab to backward focus navigation', () => {
    const { controls, input } = mount()
    fireEvent.change(input, { target: { value: '/p' } })
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(input).toHaveValue('/p')
    expect(controls.command).not.toHaveBeenCalled()
  })
})
it('shows the model window with nothing used before the first turn and the popover invokes the compact operation', async () => {
  const controls = controller()
  render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  expect(screen.getByText('0 tokens in context / 200,000 native context window')).toBeInTheDocument()
  expect(screen.queryByText(/Native default window:/)).not.toBeInTheDocument()
  expect(screen.getByText('Automatic compaction: default')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Compact context' }))
  await waitFor(() => expect(controls.change).toHaveBeenCalledWith({ kind: 'compact' }))
})

it('shows no context meter before the first turn when the model window is not known yet', () => {
  const controls = controller()
  controls.state = { ...state, capabilities: { ...state.capabilities, modelCapacity: null } }
  render(<SessionContext controls={controls} />)
  expect(screen.queryByRole('button', { name: /context/i })).not.toBeInTheDocument()
  expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument()
})

it('labels estimated occupancy and separates current, configured, default and lifetime values', () => {
  const controls = controller()
  controls.state = SessionControlStateSchema.parse({ ...state,
    applied: { ...state.applied, contextBudget: 100000 },
    capabilities: { ...state.capabilities, modelCapacity: 200000, nativeDefaultCapacity: 160000 },
    context: { nativeSessionId: 'native-chat', model: 'model', generation: 'runtime', sequence: 3,
      observedAt: '2026-10-06T00:00:00.000Z', source: 'claude', accuracy: 'estimated',
      usedTokens: 50000, capacityTokens: 100000, lifetimeTokens: 800000, cost: null, stale: false },
  })
  const view = render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: 'About 50% context' }))
  expect(screen.getByText('Estimated usage: 50,000 tokens in context / 100,000 native context window')).toBeInTheDocument()
  expect(screen.getByText('Configured budget: 100,000')).toBeInTheDocument()
  expect(screen.getByText('Model capacity: 200,000')).toBeInTheDocument()
  expect(screen.getByText('Native default window: 160,000 tokens')).toBeInTheDocument()
  expect(screen.getByText('Total processed: 800,000')).toBeInTheDocument()

  controls.state = { ...controls.state!, context: { ...controls.state!.context!, accuracy: 'native' } }
  view.rerender(<SessionContext controls={controls} />)
  expect(screen.getByRole('button', { name: '50% context' })).toBeInTheDocument()
  expect(screen.getByText('50,000 tokens in context / 100,000 native context window')).toBeInTheDocument()
  expect(screen.queryByText(/Estimated usage:/)).not.toBeInTheDocument()
})

it('closes context details with Escape and restores focus to the meter', () => {
  render(<SessionContext controls={controller()} />)
  const meter = screen.getByRole('button', { name: '0% context' })
  fireEvent.click(meter)
  const close = screen.getByRole('button', { name: 'Close context details' })
  close.focus()
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByText(/native context window/)).not.toBeInTheDocument()
  expect(meter).toHaveFocus()
})

it('renders the shared numeric budget field and submits a plain token value', async () => {
  const controls = controller()
  controls.state = { ...state, capabilities: { ...state.capabilities, modelCapacity: 200000,
    autoCompactBudget: { supported: true, reason: null } } }
  render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  fireEvent.click(screen.getByText('Context options for this chat'))
  const input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  fireEvent.change(input, { target: { value: '150000' } })
  fireEvent.blur(input)
  await waitFor(() => expect(controls.change).toHaveBeenCalledWith({ kind: 'preferences',
    preferences: { ...state.desired, autoCompactTokens: 150000 } }))
})

it('refreshes the budget from persisted readback and ignores an untouched blur', () => {
  const controls = controller()
  controls.state = { ...state, desired: { ...state.desired, autoCompactTokens: 150000 },
    capabilities: { ...state.capabilities, modelCapacity: 200000, autoCompactBudget: { supported: true, reason: null } } }
  const view = render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  let input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  fireEvent.change(input, { target: { value: '160000' } })
  fireEvent.blur(input)
  expect(controls.change).toHaveBeenCalledTimes(1)
  vi.mocked(controls.change).mockClear()
  controls.state = { ...controls.state!, desired: { ...state.desired, autoCompactTokens: 180000 } }
  view.rerender(<SessionContext controls={controls} />)
  input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  expect(input).toHaveValue(180000)
  fireEvent.focus(input)
  fireEvent.blur(input)
  expect(controls.change).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '180000' } })
  fireEvent.blur(input)
  expect(controls.change).not.toHaveBeenCalled()
})

it('saves the edited budget as defaults without a competing blur write', () => {
  const controls = controller()
  controls.state = { ...state, capabilities: { ...state.capabilities, modelCapacity: 200000,
    autoCompactBudget: { supported: true, reason: null } } }
  render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  const input = screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })
  fireEvent.change(input, { target: { value: '150000' } })
  const save = screen.getByRole('button', { name: 'Save as default for future chats' })
  fireEvent.mouseDown(save)
  fireEvent.blur(input, { relatedTarget: save })
  fireEvent.click(save)
  expect(controls.change).toHaveBeenCalledExactlyOnceWith({ kind: 'save-default',
    preferences: { ...state.desired, autoCompactTokens: 150000 } })
})

it('keeps an unsaved budget through polling and resets it when the chat changes', () => {
  const controls = controller()
  controls.state = { ...state, capabilities: { ...state.capabilities, modelCapacity: 200000,
    autoCompactBudget: { supported: true, reason: null } } }
  const view = render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' }), { target: { value: '150000' } })
  controls.state = { ...controls.state!, revision: 2, desired: { ...state.desired, autoCompactTokens: 180000 } }
  view.rerender(<SessionContext controls={controls} />)
  expect(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })).toHaveValue(150000)
  controls.state = { ...controls.state!, conversationId: 'other-chat', desired: { ...state.desired, autoCompactTokens: 190000 } }
  view.rerender(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  expect(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })).toHaveValue(190000)
})

it('resets an unsaved budget when switching nodes before either conversation exists', () => {
  const controls = Object.assign(controller(), { scope: 'first-node' })
  controls.state = { ...state, conversationId: null,
    capabilities: { ...state.capabilities, modelCapacity: 200000,
      autoCompactBudget: { supported: true, reason: null } } }
  const view = render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' }), {
    target: { value: '150000' },
  })
  controls.scope = 'second-node'
  view.rerender(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  expect(screen.getByRole('spinbutton', { name: 'Auto-compaction budget' })).toHaveValue(null)
  fireEvent.click(screen.getByRole('button', { name: 'Save as default for future chats' }))
  expect(controls.change).toHaveBeenCalledExactlyOnceWith({ kind: 'save-default', preferences: state.desired })
})

it('keeps the Operator composer compact: attach inline with the input, only agent settings below, no session options', () => {
  const controls = controller()
  controls.state = { ...state, desiredMode: 'plan', appliedMode: 'regular',
    context: { nativeSessionId: 'native-chat', model: 'model', generation: 'runtime', sequence: 3,
      observedAt: '2026-10-06T00:00:00.000Z', source: 'codex', accuracy: 'native',
      usedTokens: 25000, capacityTokens: 100000, lifetimeTokens: null, cost: null, stale: false } }
  render(<OperatorComposer conversationId="chat" sessionControls={controls} onNewChat={vi.fn()} onSubmit={vi.fn()}
    attachmentControl={<button type="button">Attach files</button>} context={<button type="button">Agent settings: model</button>} />)
  const input = screen.getByRole('textbox', { name: 'Message' }).parentElement!
  expect(Array.from(input.querySelectorAll('button')).map(element => element.getAttribute('aria-label') ?? element.textContent?.trim()))
    .toEqual(['Attach files', 'Send message'])
  const options = input.nextElementSibling!
  expect(Array.from(options.querySelectorAll('button, select')).map(element => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? ''))
    .toEqual(['Agent settings: model'])
  expect(screen.queryByRole('combobox', { name: 'Conversation mode' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /context/ })).not.toBeInTheDocument()
  expect(screen.queryByText(/starts on the next turn/)).not.toBeInTheDocument()
})

it('shows context left as a compact labelled percentage in the header', () => {
  const controls = controller()
  controls.state = { ...state, context: { nativeSessionId: 'native-chat', model: 'model', generation: 'runtime', sequence: 3,
    observedAt: '2026-10-06T00:00:00.000Z', source: 'codex', accuracy: 'native',
    usedTokens: 25000, capacityTokens: 100000, lifetimeTokens: null, cost: null, stale: false } }
  render(<SessionContext controls={controls} />)
  const meter = screen.getByRole('button', { name: '25% context' })
  expect(meter).toHaveTextContent('25%')
  expect(meter).not.toHaveTextContent('context')
})

it('moves native context help into a hint while retaining actionable budget reasons', () => {
  const controls = controller()
  const view = render(<SessionContext controls={controls} />)
  fireEvent.click(screen.getByRole('button', { name: '0% context' }))
  fireEvent.click(screen.getByText('Context options for this chat'))
  expect(screen.queryByText('Context size follows the native model/profile.')).not.toBeInTheDocument()
  fireEvent.focus(screen.getByRole('button', { name: 'About Context options' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Context size follows the native model/profile.')
  view.rerender(<SessionContext controls={{ ...controls, state: { ...state,
    capabilities: { ...state.capabilities, contextBudgetReason: 'Choose a supported model to configure a budget.' } } }} />)
  expect(screen.getByText('Choose a supported model to configure a budget.')).toBeVisible()
})
