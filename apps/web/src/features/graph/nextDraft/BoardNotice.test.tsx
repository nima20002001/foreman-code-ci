import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BoardNotice } from './BoardNotice'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('expires after four seconds and shows a new occurrence of the same error', () => {
  vi.useFakeTimers()
  const first = new Error('Save failed')
  const view = render(<BoardNotice noticeKey={first} title="Can’t save." />)
  act(() => vi.advanceTimersByTime(3999))
  expect(screen.getByText('Can’t save.')).toBeVisible()
  act(() => vi.advanceTimersByTime(1))
  act(() => vi.advanceTimersByTime(180))
  expect(screen.queryByText('Can’t save.')).not.toBeInTheDocument()
  view.rerender(<BoardNotice noticeKey={new Error('Save failed')} title="Can’t save." />)
  expect(screen.getByText('Can’t save.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
  act(() => vi.advanceTimersByTime(180))
  expect(screen.queryByText('Can’t save.')).not.toBeInTheDocument()
})
