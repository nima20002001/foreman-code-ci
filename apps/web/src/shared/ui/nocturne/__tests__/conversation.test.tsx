import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageComposer, ArtifactCard, MessageBubble } from '..'

afterEach(cleanup)
it('blocks empty messages', async () => {
  const send = vi.fn()
  render(<MessageComposer value="   " onValueChange={vi.fn()} onSend={send} />)
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }); expect(send).not.toHaveBeenCalled()
})
it('sends without clearing caller-owned drafts', async () => {
  const send = vi.fn(); const change = vi.fn()
  render(<MessageComposer value="Keep this draft" onValueChange={change} onSend={send} error="Delivery failed." />)
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(send).toHaveBeenCalledWith('Keep this draft'); expect(change).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox')).toHaveValue('Keep this draft')
})
it('does not send during IME composition or Shift+Enter', () => {
  const send = vi.fn()
  render(<MessageComposer value="A message" onValueChange={vi.fn()} onSend={send} />)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true })
  expect(send).not.toHaveBeenCalled()
})
it('can block sending without locking a caller-owned draft', () => {
  const send = vi.fn(); const change = vi.fn()
  render(<MessageComposer value="Next message" onValueChange={change} onSend={send} sendDisabled sendLabel="Send message" formLabel="Conversation composer" />)
  expect(screen.getByRole('form', { name: 'Conversation composer' })).toBeInTheDocument()
  expect(screen.getByRole('textbox')).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Editable draft' } })
  expect(change).toHaveBeenCalledWith('Editable draft')
})
it('exposes stop only when supplied by the runtime owner', () => {
  const { rerender } = render(<MessageComposer pending value="A message" onValueChange={vi.fn()} onSend={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
  rerender(<MessageComposer pending onStop={vi.fn()} value="A message" onValueChange={vi.fn()} onSend={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
})
it('renders message text without interpreting HTML', () => {
  render(<MessageBubble author="Operator">{'<script>not executed</script>'}</MessageBubble>)
  expect(screen.getByRole('article')).toHaveTextContent('<script>not executed</script>')
  expect(document.querySelector('script')).toBeNull()
})
it('does not invent artifact URLs or actions', () => {
  render(<ArtifactCard title="Plan" />)
  expect(screen.queryByRole('link')).not.toBeInTheDocument(); expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('keeps keyboard guidance available through a hint and accessible description while showing the count', async () => {
  render(<MessageComposer value="Hello" onValueChange={vi.fn()} onSend={vi.fn()} />)
  const guidance = 'Enter to send · Shift + Enter for a new line'
  expect(screen.getByRole('textbox')).toHaveAccessibleDescription(expect.stringContaining(guidance))
  expect(screen.getByText('5 / 16,000')).toBeVisible()
  expect(screen.getByText(guidance)).not.toBeVisible()
  await userEvent.hover(screen.getByRole('button', { name: 'About Message the operator' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(guidance)
})
