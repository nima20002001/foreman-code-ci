import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ConversationHistory } from './ConversationHistory'

it('identifies a shortened answer when reading saved conversation history', () => {
  render(<ConversationHistory messages={[{ id: 'answer', conversationId: 'chat', role: 'assistant',
    content: 'Saved prefix', truncation: { truncated: true, originalBytes: 30_000 } }]} />)
  expect(screen.getByText('Saved prefix')).toBeVisible()
  expect(screen.getByRole('note', { name: 'Shortened message' })).toHaveTextContent(/^This message was shortened\.$/)
})

it('shows an empty history without repeating its purpose', () => {
  render(<ConversationHistory messages={[]} />)
  expect(screen.getByRole('heading', { name: 'No conversation history yet' })).toBeVisible()
  expect(screen.queryByText('Messages will appear here after the conversation starts.')).not.toBeInTheDocument()
})
