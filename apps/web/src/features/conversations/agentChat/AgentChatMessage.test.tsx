import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AgentChatMessage } from './AgentChatMessage'

afterEach(cleanup)

it('renders agent markdown with lists, links and copyable fenced code', () => {
  render(<AgentChatMessage name="Builder" message={{ id: 'reply', role: 'assistant', content:
    '## Result\n\n- **Ready**\n- [Documentation](https://example.com/docs)\n\n```sh\npnpm test\n```',
  }} />)
  expect(screen.getByRole('heading', { name: 'Result' })).toBeVisible()
  expect(screen.getByRole('list')).toHaveTextContent('Ready')
  expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', 'https://example.com/docs')
  expect(screen.getByLabelText('Code')).toHaveTextContent('pnpm test')
  expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled()
})

it('updates streaming text in the same message as new content arrives', () => {
  const { rerender } = render(<AgentChatMessage name="Builder"
    message={{ id: 'reply', role: 'assistant', content: 'Reading', nativeMessageComplete: false }} />)
  rerender(<AgentChatMessage name="Builder"
    message={{ id: 'reply', role: 'assistant', content: 'Reading the files. **Done.**', nativeMessageComplete: true }} />)
  expect(screen.getAllByRole('article', { name: 'Message from Builder' })).toHaveLength(1)
  expect(screen.getByRole('article')).toHaveTextContent('Reading the files. Done.')
})

it('keeps user input literal and prevents markup or unsafe links from executing', () => {
  const { rerender } = render(<AgentChatMessage name="Builder"
    message={{ id: 'input', role: 'user', content: '**Keep this text**' }} />)
  expect(screen.getByRole('article', { name: 'Message from You' })).toHaveTextContent('**Keep this text**')
  rerender(<AgentChatMessage name="Builder" message={{ id: 'reply', role: 'assistant',
    content: '<script>alert(1)</script>\n\n[Unsafe](javascript:alert(1))\n\n![Remote image](https://example.com/image.png)',
  }} />)
  expect(screen.getByText('Unsafe')).toHaveAttribute('href', '')
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.getByRole('article')).not.toHaveTextContent('alert(1)')
})

it('keeps published files available when a tool message is expanded', async () => {
  render(<AgentChatMessage name="Builder" message={{ id: 'tool', role: 'tool', content: 'Created a report.' }}>
    <button type="button">Open report</button>
  </AgentChatMessage>)
  await userEvent.click(screen.getByText('Tool output', { selector: 'summary' }))
  expect(screen.getByRole('button', { name: 'Open report' })).toBeVisible()
  expect(screen.getByLabelText('Tool output')).toHaveTextContent('Created a report.')
})
