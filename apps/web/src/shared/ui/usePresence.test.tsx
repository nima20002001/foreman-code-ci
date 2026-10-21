import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePresence } from './usePresence'

function PresenceHost({ open }: { open: boolean }) {
  const presence = usePresence(open)
  if (!presence.mounted) return null
  return <div data-testid="surface" data-state={presence.exiting ? 'exiting' : 'open'} />
}

function enableMotion() {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
}

afterEach(() => {
  delete (Element.prototype as { animate?: unknown }).animate
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('usePresence', () => {
  it('unmounts immediately when the environment cannot animate', () => {
    const { rerender } = render(<PresenceHost open />)
    expect(screen.getByTestId('surface')).toBeInTheDocument()

    rerender(<PresenceHost open={false} />)
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument()
  })

  it('holds an exiting surface until the exit duration elapses', () => {
    enableMotion()
    vi.useFakeTimers()
    const { rerender } = render(<PresenceHost open />)

    rerender(<PresenceHost open={false} />)
    expect(screen.getByTestId('surface')).toHaveAttribute('data-state', 'exiting')

    act(() => vi.advanceTimersByTime(200))
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument()
  })

  it('unmounts immediately when the user prefers reduced motion', () => {
    enableMotion()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const { rerender } = render(<PresenceHost open />)

    rerender(<PresenceHost open={false} />)
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument()
  })
})
