import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileDrop } from './useFileDrop'

afterEach(cleanup)
function Target({ onFiles, disabled = false, maxFiles }: { onFiles: (files: File[]) => void; disabled?: boolean; maxFiles?: number }) {
  const drop = useFileDrop({ onFiles, disabled, maxFiles })
  return <div data-testid="drop" {...drop.dropTargetProps}><span>Child</span>{drop.dropError && <p role="alert">{drop.dropError}</p>}</div>
}
const file = new File(['# context'], 'context.md', { type: 'text/markdown' })
const transfer = (files = [file]) => ({ types: ['Files'], files, items: [], dropEffect: 'none' })

it('keeps nested drag feedback stable, prevents file navigation, and forwards the original files once', () => {
  const onFiles = vi.fn(); render(<Target onFiles={onFiles} />)
  const target = screen.getByTestId('drop'), child = screen.getByText('Child'), dataTransfer = transfer()
  fireEvent.dragEnter(target, { dataTransfer }); fireEvent.dragEnter(child, { dataTransfer })
  fireEvent.dragLeave(child, { dataTransfer })
  expect(target).toHaveAttribute('data-file-dragging', 'true')
  const event = createEvent.drop(child, { dataTransfer }); fireEvent(child, event)
  expect(event.defaultPrevented).toBe(true)
  expect(onFiles).toHaveBeenCalledExactlyOnceWith([file])
  expect(target).not.toHaveAttribute('data-file-dragging')
})

it('does not capture text, URLs, or internal graph drags', () => {
  const onFiles = vi.fn(); render(<Target onFiles={onFiles} />)
  const target = screen.getByTestId('drop')
  for (const type of ['text/plain', 'text/uri-list', 'application/reactflow']) {
    const dataTransfer = { types: [type], files: [] }
    const enter = createEvent.dragEnter(target, { dataTransfer }); fireEvent(target, enter)
    const event = createEvent.drop(target, { dataTransfer }); fireEvent(target, event)
    expect(enter.defaultPrevented).toBe(false); expect(event.defaultPrevented).toBe(false)
  }
  expect(onFiles).not.toHaveBeenCalled(); expect(target).not.toHaveAttribute('data-file-dragging')
})

it('blocks disabled writes while preventing the browser from opening dropped files', () => {
  const onFiles = vi.fn(); render(<Target onFiles={onFiles} disabled />)
  const target = screen.getByTestId('drop'), dataTransfer = transfer()
  fireEvent.dragEnter(target, { dataTransfer }); fireEvent.dragOver(target, { dataTransfer })
  expect(target).not.toHaveAttribute('data-file-dragging'); expect(dataTransfer.dropEffect).toBe('none')
  const event = createEvent.drop(target, { dataTransfer }); fireEvent(target, event)
  expect(event.defaultPrevented).toBe(true); expect(onFiles).not.toHaveBeenCalled()
})

it('rejects directory/mixed drops and excess single-file selections without silently discarding inputs', () => {
  const onFiles = vi.fn(); render(<Target onFiles={onFiles} maxFiles={1} />)
  const target = screen.getByTestId('drop')
  fireEvent.drop(target, { dataTransfer: { ...transfer(), items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } })
  expect(screen.getByRole('alert')).toHaveTextContent('Folders are not supported')
  fireEvent.drop(target, { dataTransfer: transfer([file, file]) })
  expect(screen.getByRole('alert')).toHaveTextContent('one file at a time')
  expect(onFiles).not.toHaveBeenCalled()
  fireEvent.drop(target, { dataTransfer: transfer() })
  expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]); expect(screen.queryByRole('alert')).toBeNull()
})
