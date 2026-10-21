import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_INTERACTION_FIXTURES, type ReviewStatus } from '@foreman-code/contracts'
import { ReviewStatusNotice } from './ReviewStatusNotice'

afterEach(() => { cleanup(); vi.useRealTimers() })
it('keeps the error visible as a scheduled retry becomes due, then preserves canceled failure history', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'))
  const review: ReviewStatus = { state: 'blocked_disconnected', attempt: 1,
    error: { code: 'REVIEW_SESSION_DISCONNECTED', message: 'Existing session disconnected.' },
    updatedAt: new Date().toISOString(), retryAfter: new Date(Date.now() + 2000).toISOString(), reviewJobId: 'job-A' }
  const interaction = NATIVE_INTERACTION_FIXTURES.codex
  const view = render(<ReviewStatusNotice review={review} interaction={interaction} />)
  expect(screen.getByText('Existing session disconnected.')).toBeTruthy()
  expect(screen.getByText(/Retry scheduled for/)).toBeTruthy()
  act(() => { vi.advanceTimersByTime(3000) })
  expect(screen.getByText('Existing session disconnected.')).toBeTruthy()
  expect(screen.getByText('Retry is due; waiting for the next backend check.')).toBeTruthy()
  view.rerender(<ReviewStatusNotice review={{ ...review, state: 'failed', cleanupPending: true }}
    interaction={{ ...interaction, status: 'canceled' }} />)
  expect(screen.getByText('Orchestrator review stopped')).toBeTruthy()
  expect(screen.getByText(/cleanup is still pending/)).toBeTruthy()
  view.unmount()
  render(<ReviewStatusNotice review={{ ...review, state: 'failed', cleanupPending: false }}
    interaction={{ ...interaction, status: 'canceled' }} />)
  expect(screen.getByText('Existing session disconnected.')).toBeTruthy()
  expect(screen.getByText(/Cleanup finished/)).toBeTruthy()
})
