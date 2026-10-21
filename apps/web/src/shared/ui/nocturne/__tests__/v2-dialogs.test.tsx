import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ActionMenu, BottomSheet, ContextMenu, Dialog, Drawer, SettingsDialog, WizardDialog,
  ChangeReview, ProgressDialog, ResourcePickerDialog, ReviewChangesDialog, TextField,
  type SettingDefinition, type SettingValue, type SettingsDialogProps,
} from '..'

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

const fields: readonly SettingDefinition[] = [
  { id: 'name', label: 'Agent name', section: 'Identity', type: 'text', required: true },
  { id: 'timeout', label: 'Timeout', section: 'Execution', type: 'number', min: 30, max: 3600, step: 1, advanced: true },
  { id: 'motion', label: 'Motion', section: 'Interface', type: 'switch' },
  { id: 'scope', label: 'Effective scope', section: 'Security', type: 'text', readOnly: true },
]
function SettingsExample(extra: Partial<SettingsDialogProps>) {
  const [open, setOpen] = useState(true)
  const [values, setValues] = useState<Record<string, SettingValue>>({ name: 'Builder', timeout: '600', motion: true, scope: 'Read only' })
  return <SettingsDialog title="Configure" open={open} onOpenChange={setOpen} fields={fields} values={values} onValueChange={(id, value) => setValues(previous => ({ ...previous, [id]: value }))} onSave={vi.fn()} dirty {...extra} />
}
describe('Advanced configuration and modal contracts', () => {
  it('finds advanced settings before the advanced toggle is enabled', async () => {
    render(<SettingsExample />)
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'timeout')
    expect(screen.getByRole('spinbutton', { name: 'Timeout' })).toHaveValue(600)
    expect(screen.getByRole('switch', { name: 'Advanced' })).not.toBeChecked()
  })
  it('rejects an invalid setting even while its section is hidden', () => {
    render(<SettingsExample values={{ name: 'Builder', timeout: '-1', motion: true, scope: 'Read only' }} />)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('field needs attention')
  })
  it('keeps controlled drafts across search and section changes', async () => {
    render(<SettingsExample />)
    await userEvent.clear(screen.getByRole('textbox', { name: 'Agent name' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Agent name' }), 'Keep this')
    await userEvent.click(screen.getByRole('button', { name: /^Execution$/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Identity$/ }))
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toHaveValue('Keep this')
  })
  it('keeps fields editable during a conflict but blocks saving', async () => {
    const save = vi.fn(); render(<SettingsExample conflict="Version changed" onSave={save} />)
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByText(/Your draft has been kept/)).toBeVisible()
  })
  it('honors feature-level read-only permission', () => {
    render(<SettingsExample readOnly />)
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })
  it('locks fields, close controls, and native cancel while saving', () => {
    const close = vi.fn(); render(<SettingsExample pending onOpenChange={close} />)
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toBeDisabled()
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
  })
  it('opens a separate unsaved-changes confirmation and can return to editing', async () => {
    render(<SettingsExample />)
    await userEvent.click(screen.getByRole('button', { name: /^Close$/ }))
    const confirmation = screen.getByRole('alertdialog')
    expect(confirmation).toHaveAccessibleName('Close with unsaved changes?')
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Agent name' })).toHaveValue('Builder')
  })
  it('links a server-supplied switch error to the switch', async () => {
    render(<SettingsExample errors={{ motion: 'This preference is locked.' }} />)
    await userEvent.click(screen.getByRole('button', { name: /Interface/ }))
    expect(screen.getByRole('switch', { name: /^Motion$/ })).toHaveAccessibleDescription('This preference is locked.')
  })
  it('redacts both sides of secret configuration changes', () => {
    render(<ChangeReview changes={[{ id: 'secret', label: 'Credential reference', before: 'old-secret', after: 'new-secret', secret: true }]} />)
    expect(document.body.textContent).not.toContain('old-secret')
    expect(document.body.textContent).not.toContain('new-secret')
    expect(screen.getAllByText(/redacted/)).toHaveLength(2)
  })
  it('requires an explicit capability to apply changes', () => {
    render(<ReviewChangesDialog open title="Review" onOpenChange={vi.fn()} changes={[{ id: 'n', label: 'Name', before: 'A', after: 'B' }]} onApply={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
  })
  it('blocks an empty or conflicting review even with capability', () => {
    render(<ReviewChangesDialog open title="Review" onOpenChange={vi.fn()} changes={[]} canApply conflict="Newer state exists" onApply={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeDisabled()
    expect(screen.getByText('Nothing to review')).toBeVisible()
  })
  it('separates hiding progress from requesting cancellation', async () => {
    const close = vi.fn()
    render(<ProgressDialog open title="Preparing" onOpenChange={close} status="Working" />)
    expect(screen.queryByRole('button', { name: 'Request cancellation' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Hide progress' }))
    expect(close).toHaveBeenCalledWith(false)
  })
  it('blocks completion when the current wizard input is invalid', async () => {
    const complete = vi.fn()
    render(<WizardDialog open title="Setup" onOpenChange={vi.fn()} steps={[{ id: 'name', title: 'Name', content: <TextField label="Required name" required /> }]} current={0} onStepChange={vi.fn()} onComplete={complete} />)
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(complete).not.toHaveBeenCalled()
  })
  it('keeps uncontrolled wizard inputs mounted across steps', async () => {
    function WizardExample() { const [current, setCurrent] = useState(0); return <WizardDialog open title="Setup" onOpenChange={vi.fn()} steps={[{ id: 'name', title: 'Identity', content: <TextField label="Name" /> }, { id: 'review', title: 'Review', content: 'Review changes' }]} current={current} onStepChange={setCurrent} onComplete={vi.fn()} /> }
    render(<WizardExample />); await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Keep me')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Keep me')
  })
  it('handles an empty wizard without permitting completion', () => {
    render(<WizardDialog open title="Setup" onOpenChange={vi.fn()} steps={[]} current={Infinity} onStepChange={vi.fn()} onComplete={vi.fn()} />)
    expect(screen.getByText('No steps available')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })
  it('keeps a resource selected while a search hides it', async () => {
    const confirm = vi.fn()
    render(<ResourcePickerDialog open title="Choose" onOpenChange={vi.fn()} resources={[{ id: 'opaque-workspace-id', title: 'Website' }]} selectedId="opaque-workspace-id" onSelect={vi.fn()} onConfirm={confirm} />)
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search resources' }), 'missing')
    await userEvent.click(screen.getByRole('button', { name: 'Use selected' }))
    expect(confirm).toHaveBeenCalledWith('opaque-workspace-id')
  })
  it('does not confirm a resource that is disabled or no longer present', () => {
    render(<ResourcePickerDialog open title="Choose" onOpenChange={vi.fn()} resources={[{ id: 'w', title: 'Website', disabled: true }]} selectedId="w" onSelect={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Use selected' })).toBeDisabled()
  })
  it('protects a generic busy dialog without requiring a second flag', () => {
    const close = vi.fn(); render(<Dialog open title="Saving" busy closeOnOutsideClick onOpenChange={close}>Draft</Dialog>)
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
  })
  it('dismisses on a backdrop click by default but keeps inside clicks and drags open', () => {
    const close = vi.fn()
    render(<Dialog open title="Example" onOpenChange={close}><button>Inside</button></Dialog>)
    const dialog = screen.getByRole('dialog')
    const inside = screen.getByRole('button', { name: 'Inside' })
    fireEvent.pointerDown(inside); fireEvent.click(inside)
    fireEvent.pointerDown(inside); fireEvent.click(dialog)
    expect(close).not.toHaveBeenCalled()
    fireEvent.pointerDown(dialog); fireEvent.click(dialog)
    expect(close).toHaveBeenCalledWith(false)
  })
  it('exposes sheet and start-side drawer variants', () => {
    const { rerender } = render(<BottomSheet open title="Actions" onOpenChange={vi.fn()}>Actions</BottomSheet>)
    expect(screen.getByRole('dialog')).toHaveClass('n-sheet')
    rerender(<Drawer open side="start" title="Inspector" onOpenChange={vi.fn()}>Details</Drawer>)
    expect(screen.getByRole('dialog')).toHaveClass('n-drawer')
    expect(screen.getByRole('dialog')).toHaveAttribute('data-side', 'start')
  })
})
describe('Nested action menus', () => {
  it('keeps disabled actions focusable without invoking them', async () => {
    const select = vi.fn()
    render(<ActionMenu label="Actions" items={[{ id: 'a', label: 'Unavailable', disabled: true, onSelect: select }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    const item = screen.getByRole('menuitem', { name: 'Unavailable' })
    expect(item).toHaveFocus(); await userEvent.keyboard('{Enter}')
    expect(select).not.toHaveBeenCalled(); expect(screen.getByRole('menu')).toBeVisible()
  })
  it('enters a submenu and restores its parent on Escape', async () => {
    render(<ActionMenu label="Actions" items={[{ id: 'inspect', label: 'Inspect', kind: 'submenu', items: [{ id: 'details', label: 'Details', onSelect: vi.fn() }] }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('menuitem', { name: 'Details' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('menuitem', { name: 'Inspect' })).toHaveFocus()
    expect(screen.queryByRole('menu', { name: 'Inspect' })).not.toBeInTheDocument()
  })
  it('keeps checkbox actions open after a controlled state update', async () => {
    function CheckMenu() { const [checked, setChecked] = useState(false); return <ActionMenu label="Actions" items={[{ id: 'notes', kind: 'checkbox', label: 'Notes', checked, onCheckedChange: setChecked }]} /> }
    render(<CheckMenu />); await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Notes' }))
    expect(screen.getByRole('menuitemcheckbox', { name: 'Notes' })).toHaveAttribute('aria-checked', 'true')
  })
  it('closes after an explicit radio selection', async () => {
    const select = vi.fn(); render(<ActionMenu label="View" items={[{ id: 'list', kind: 'radio', label: 'List', checked: false, onSelect: select }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'View' })); await userEvent.click(screen.getByRole('menuitemradio', { name: 'List' }))
    expect(select).toHaveBeenCalledOnce(); expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
  it('opens context actions without a mouse', () => {
    render(<ContextMenu label="Node actions" items={[{ id: 'inspect', label: 'Inspect', onSelect: vi.fn() }]}><button type="button">Agent node</button></ContextMenu>)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Agent node' }), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menuitem', { name: 'Inspect' })).toHaveFocus()
  })
  it('keeps action descriptions separate from their accessible names', async () => {
    render(<ActionMenu label="Actions" items={[{ id: 'policy', label: 'Change policy', description: 'Owner access required', disabled: true, onSelect: vi.fn() }]} />)
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }))
    expect(screen.getByRole('menuitem', { name: /^Change policy$/ })).toHaveAccessibleDescription('Owner access required')
  })
})
