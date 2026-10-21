import '@testing-library/jest-dom/vitest'
import { StrictMode, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Button, Combobox, ConfirmDialog, Dialog, DropdownMenu, Tooltip } from '..'

// jsdom has no top-layer layout, modal inertness or browser tab order.
// These mocks only test React state/focus wiring. Use browser checks for native semantics.
const missingMethods: { target: object; key: string; descriptor?: PropertyDescriptor }[] = []
function ensureMethod(target: object, key: string) {
  if (typeof Reflect.get(target, key) === 'function') return
  missingMethods.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) })
  Object.defineProperty(target, key, { configurable: true, writable: true, value: () => undefined })
}
beforeEach(() => {
  ensureMethod(HTMLDialogElement.prototype, 'showModal')
  ensureMethod(HTMLDialogElement.prototype, 'close')
  ensureMethod(HTMLElement.prototype, 'scrollIntoView')
  ensureMethod(HTMLElement.prototype, 'showPopover')
  ensureMethod(HTMLElement.prototype, 'hidePopover')
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true })
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
    this.open = false
    queueMicrotask(() => this.dispatchEvent(new Event('close')))
  })
  // Properties may not be implemented by the installed jsdom version.
  vi.stubGlobal('ResizeObserver', undefined)
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  vi.spyOn(HTMLElement.prototype, 'showPopover').mockImplementation(function (this: HTMLElement) {
    this.dataset.testPopoverOpen = 'true'
    this.style.display = 'block'
  })
  vi.spyOn(HTMLElement.prototype, 'hidePopover').mockImplementation(function (this: HTMLElement) {
    delete this.dataset.testPopoverOpen
    this.style.removeProperty('display')
  })
  const matches = Element.prototype.matches
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':popover-open' ? this.hasAttribute('data-test-popover-open') : matches.call(this, selector)
  })
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  missingMethods.splice(0).forEach(({ target, key, descriptor }) => {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  })
})

describe('Nocturne interactions', () => {
  const options = [{ value: 'codex', label: 'Codex' }, { value: 'disabled', label: 'Unavailable', disabled: true }, { value: 'claude', label: 'Claude' }]
  function HarnessPicker() { const [value, setValue] = useState('codex'); return <Combobox label="Harness" options={options} value={value} onValueChange={setValue} /> }
  it('selects filtered options with the keyboard', async () => {
    render(<HarnessPicker />)
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.type(screen.getByRole('combobox'), 'clau')
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('combobox')).toHaveValue('Claude')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
  it('opens again when the already-focused input is clicked', async () => {
    render(<HarnessPicker />)
    await userEvent.click(screen.getByRole('combobox')); await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('combobox')).toHaveFocus()
    await userEvent.click(screen.getByRole('combobox'))
    expect(screen.getByRole('listbox')).toBeVisible()
  })
  it('keeps the model picker closed when its label outside the field is clicked', async () => {
    render(<Combobox label="Model" value="luna" options={[{ value: 'luna', label: 'Luna' }, { value: 'sol', label: 'Sol' }]} onValueChange={vi.fn()} />)
    await userEvent.click(screen.getByText('Model'))
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('combobox', { name: 'Model' })).not.toHaveFocus()
    await userEvent.click(screen.getByRole('combobox', { name: 'Model' }))
    expect(screen.getByRole('listbox', { name: 'Model' })).toBeVisible()
  })
  it('skips disabled options using ArrowDown', async () => {
    render(<HarnessPicker />)
    await userEvent.click(screen.getByRole('combobox')); await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByRole('combobox')).toHaveValue('Claude')
  })
  it('restores the selected label on Escape without changing the value', async () => {
    render(<HarnessPicker />)
    await userEvent.click(screen.getByRole('combobox')); await userEvent.type(screen.getByRole('combobox'), 'missing')
    expect(screen.getByRole('status')).toHaveTextContent('No matching options.')
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('combobox')).toHaveValue('Codex')
  })
  it('ignores composing Enter events', async () => {
    const change = vi.fn()
    render(<Combobox label="Harness" value="codex" options={options} onValueChange={change} />)
    await userEvent.click(screen.getByRole('combobox'))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true })
    expect(change).not.toHaveBeenCalled()
  })
  it('keeps no active descendant when all matching options are disabled', async () => {
    render(<HarnessPicker />); await userEvent.click(screen.getByRole('combobox'))
    await userEvent.type(screen.getByRole('combobox'), 'Unavailable')
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-activedescendant')
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('listbox')).toBeVisible()
  })
  it('supports menu keyboard navigation and restores the trigger', async () => {
    const select = vi.fn()
    render(<DropdownMenu label="Actions" items={[{ id: 'a', label: 'First', onSelect: select }, { id: 'b', label: 'Disabled', disabled: true, onSelect: select }, { id: 'c', label: 'Last', onSelect: select }]} />)
    const trigger = screen.getByRole('button', { name: 'Actions' }); trigger.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Last' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveFocus(); expect(select).not.toHaveBeenCalled()
  })
  it('does not open an all-disabled menu', async () => {
    render(<DropdownMenu label="Actions" items={[{ id: 'a', label: 'Unavailable', disabled: true, onSelect: vi.fn() }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it('focuses a named dialog and restores focus on cancel in StrictMode', async () => {
    function Example() { const [open, setOpen] = useState(false); return <><Button onClick={() => setOpen(true)}>Open</Button><Dialog open={open} onOpenChange={setOpen} title="Details"><p>Content</p></Dialog></> }
    render(<StrictMode><Example /></StrictMode>)
    const trigger = screen.getByRole('button', { name: 'Open' }); await userEvent.click(trigger)
    expect(screen.getByRole('heading', { name: 'Details' })).toHaveFocus()
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(trigger).toHaveFocus(); expect(document.body.style.overflow).not.toBe('hidden')
  })
  it('does not dismiss a pending modal with native cancel', () => {
    const change = vi.fn()
    render(<Dialog open dismissible={false} onOpenChange={change} title="Saving"><p>Pending</p></Dialog>)
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
  })
  it('requires exact confirmation and resets the typed value after reopening', async () => {
    const confirm = vi.fn()
    const props = { onOpenChange: vi.fn(), title: 'Delete workspace', description: 'No undo', confirmation: 'DELETE', confirmLabel: 'Delete now', onConfirm: confirm }
    const { rerender } = render(<ConfirmDialog {...props} open />)
    expect(screen.getByRole('button', { name: 'Delete now' })).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox'), 'DELETE')
    await userEvent.click(screen.getByRole('button', { name: 'Delete now' })); expect(confirm).toHaveBeenCalledOnce()
    rerender(<ConfirmDialog {...props} open={false} />); rerender(<ConfirmDialog {...props} open />)
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Delete now' })).toBeDisabled()
  })
})

it('does not let a lingering tooltip consume Escape from a focused combobox', async () => {
  render(<><Tooltip content="Help text"><Button>Help</Button></Tooltip><Combobox label="Picker" value="one" options={[{ value: 'one', label: 'One' }]} onValueChange={vi.fn()} /></>)
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'Help' }).parentElement as HTMLElement)
  await userEvent.click(screen.getByRole('combobox'))
  await userEvent.keyboard('{Escape}')
  expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false')
})
