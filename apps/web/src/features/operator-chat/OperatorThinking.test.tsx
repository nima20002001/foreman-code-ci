import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OperatorThinking } from './OperatorThinking'

describe('Operator thinking disclosure', () => {
  it('separates thinking from the answer and preserves the disclosure choice across streamed updates', () => {
    const view = render(<OperatorThinking text="Checking the columns." />)
    const toggle = screen.getByRole('button', { name: 'Thinking' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Thinking summary' })).not.toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByRole('region', { name: 'Thinking summary' })).toHaveTextContent('Checking the columns.')
    view.rerender(<OperatorThinking text="Checking the columns. Verifying the carries." />)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Thinking summary' })).toHaveTextContent('Verifying the carries.')
    fireEvent.click(toggle)
    view.rerender(<OperatorThinking text="The calculation is checked." />)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Thinking summary' })).not.toBeInTheDocument()
  })
})
