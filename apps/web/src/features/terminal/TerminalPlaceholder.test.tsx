import { fireEvent, render, screen } from '@testing-library/react'

import { TerminalPlaceholder } from './TerminalPlaceholder'

describe('TerminalPlaceholder', () => {
  it('states that no terminal is connected and does not render a fake prompt', () => {
    render(<TerminalPlaceholder />)

    expect(screen.getByRole('heading', { name: 'No terminal connected' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Expand' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/connect a runner to open a terminal/i)).not.toBeInTheDocument()
  })

  it('expands the explanatory state without pretending to accept terminal input', () => {
    render(<TerminalPlaceholder />)

    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))

    expect(screen.getByRole('button', { name: 'Collapse' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText(/connect a runner to open a terminal/i)).toBeVisible()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
