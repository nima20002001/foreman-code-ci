import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration } from '@foreman-code/contracts'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor } from './harnessEditor'

vi.mock('../../shared/api/query', () => ({ useManagedHarnessCatalogQuery: () => ({ data: undefined }), useHarnessDefaultsQuery: () => ({ data: { defaults: DEFAULT_HARNESS_DEFAULTS } }) }))
vi.mock('../../shared/api/harnessValidation', () => ({ useValidateHarnessConfiguration: () => ({ data: undefined, mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }) }))
afterEach(cleanup)
function Editor({ value, save }: { value: HarnessConfiguration; save(value: HarnessConfiguration): void }) {
  const [editor, setEditor] = useState(() => createHarnessEditor(value))
  return <><HarnessConfigurationFields editor={editor} onChange={setEditor} /><button onClick={() => save(prepareHarnessEditor(editor))}>Store</button></>
}
function mount(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('PR12 actual provider fields', () => {
  it('preserves server-vetted writable directory paths exactly', async () => {
    const user = userEvent.setup(); const save = vi.fn()
    const value = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
    value.sandbox = 'workspace-write'
    value.advanced!.additionalWritableDirectories = ['/first/path ', '/second/path ']
    mount(<Editor value={value} save={save} />)
    await user.click(screen.getByRole('button', { name: 'Access & approvals' }))
    expect(screen.getByText('/first/path')).toBeInTheDocument()
    expect(screen.getByText('/second/path')).toBeInTheDocument()
    await user.click(screen.getByText('Store'))
    expect(save.mock.calls[0]![0].advanced.additionalWritableDirectories).toEqual(['/first/path ', '/second/path '])
  })



  it('preserves incomplete raw JSON until Save validates it', () => {
    const editor = createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex)
    editor.mcpText = '{'
    expect(() => prepareHarnessEditor(editor)).toThrow('Native MCP controls must contain valid JSON')
    expect(editor.mcpText).toBe('{')
  })
})
