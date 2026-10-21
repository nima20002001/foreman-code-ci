import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useDismissableSurface, type SurfaceDismissReason } from './useDismissableSurface'

function Surface({
  id,
  onDismiss,
}: {
  id: string
  onDismiss?: (reason: SurfaceDismissReason) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)

  useDismissableSurface({
    open,
    onDismiss: (reason) => {
      onDismiss?.(reason)
      setOpen(false)
    },
    surfaceRef,
    triggerRef,
  })

  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open {id}
      </button>
      {open ? (
        <div ref={surfaceRef} role="dialog" aria-label={id}>
          <button type="button">Inside {id}</button>
        </div>
      ) : null}
    </div>
  )
}

describe('useDismissableSurface', () => {
  it('dismisses on Escape and ignores presses inside the surface', () => {
    render(<Surface id="menu" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const dialog = screen.getByRole('dialog', { name: 'menu' })

    fireEvent.mouseDown(dialog)
    expect(dialog).toBeVisible()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'menu' })).not.toBeInTheDocument()
  })

  it('dismisses from an outside press but not from a press on its trigger', () => {
    const onDismiss = vi.fn()
    render(<Surface id="menu" onDismiss={onDismiss} />)
    const trigger = screen.getByRole('button', { name: 'Open menu' })
    fireEvent.click(trigger)

    fireEvent.mouseDown(trigger)
    expect(screen.getByRole('dialog', { name: 'menu' })).toBeVisible()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'menu' })).not.toBeInTheDocument()
    expect(onDismiss).toHaveBeenCalledWith('outside')
  })

  it('never steals focus from the control an outside press moved focus to', async () => {
    render(
      <>
        <Surface id="menu" />
        <button type="button">Elsewhere</button>
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()

    fireEvent.mouseDown(elsewhere)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(elsewhere).toHaveFocus()
  })

  it('closes a previously open surface when another surface opens', () => {
    render(
      <>
        <Surface id="first" />
        <Surface id="second" />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open first' }))
    expect(screen.getByRole('dialog', { name: 'first' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Open second' }))
    expect(screen.queryByRole('dialog', { name: 'first' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'second' })).toBeVisible()
  })

  it('restores focus to the trigger after an outside press that lost focus to the page', async () => {
    render(<Surface id="menu" />)
    const trigger = screen.getByRole('button', { name: 'Open menu' })
    fireEvent.click(trigger)

    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
