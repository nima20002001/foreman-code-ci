import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceFolderCreateInput } from '@foreman-code/contracts/management'

import { server } from '../../mocks/server'
import { harnessSettingsKeys, type useHarnessDirectories } from '../../shared/api/harnessSettings'
import { setMockScenario } from '../../shared/mocks/scenarios'
import { mainRoot } from './workspaceBoundLocation.fixtures'
import type { BoundFolderBrowser } from '../../shared/api/workspaceBoundLocation'
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker'
import { deferred } from '../../test/deferred'

type DirectoryPage = NonNullable<ReturnType<typeof useHarnessDirectories>['data']>
const root = { id: 'projects', label: 'Projects', path: '/projects' }
function page(overrides: Partial<DirectoryPage> = {}): DirectoryPage {
  return {
    roots: [root], rootId: root.id, path: root.path, parent: null, nextCursor: null,
    directories: [{ name: 'Project', path: '/projects/Project' }], ...overrides,
  }
}
const clients: QueryClient[] = []
function mount(onSelect = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined), selectionUnconfirmed = false, value = '', directoryBinding?: BoundFolderBrowser) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><WorkspaceFolderPicker disabled={false} value={value} onSelect={onSelect} selectionUnconfirmed={selectionUnconfirmed} directoryBinding={directoryBinding} /></QueryClientProvider>)
  return { client, onSelect }
}
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Project folder' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
}
beforeEach(() => {
  setMockScenario('normal')
  server.use(
    http.post('/api/management/harnesses/directories', async ({ request }) => {
      const body = await request.json() as { parentPath: string; name?: string }
      return HttpResponse.json({ value: { name: body.name ?? 'New folder', path: body.parentPath + '/' + (body.name ?? 'New folder') }, replayed: false })
    }),
    http.post('/api/management/harnesses/directories/rename', async ({ request }) => {
      const body = await request.json() as { name: string }
      return HttpResponse.json({ value: { name: body.name, path: '/projects/' + body.name }, replayed: false })
    }),
  )
  server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
    const path = new URL(request.url).searchParams.get('path') ?? root.path
    return HttpResponse.json(path === root.path ? page() : page({ path, parent: root.path, directories: [] }))
  }))
})
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })

describe('WorkspaceFolderPicker Nocturne layout and interaction', () => {
  it.each(['/external/projects', '/projects-adjacent'])('browses and selects bound Main roots outside app-managed storage without advertising mutations: %s', async (externalPath) => {
    const user = userEvent.setup()
    const expectedHost = { ...mainRoot, bases: [{ ...mainRoot.bases[0]!, canonicalPath: externalPath }] }
    const input: BoundFolderBrowser['input'] = { workspaceId: 'workspace-1', hostRef: expectedHost.hostRef,
      allowedBaseId: expectedHost.bases[0]!.baseId, configurationRevision: '1', relativePath: '', accessMode: 'read-write',
      expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
    const writes: unknown[] = []
    server.use(
      http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => {
        const selection = await request.json() as typeof input
        return HttpResponse.json({ workspaceId: 'workspace-1', selection,
          browse: { relativePath: selection.relativePath, directories: selection.relativePath ? [] : [{ name: 'Project', relativePath: 'Project' }], truncated: false } })
      }),
      ...['', '/rename', '/undo', '/delete'].map(suffix => http.post('/api/management/harnesses/directories' + suffix, async ({ request }) => {
        writes.push(await request.json()); return HttpResponse.json({}, { status: 403 })
      })),
    )
    const { onSelect } = mount(undefined, false, externalPath, { input, expectedHost })
    await openPicker(user)
    const folder = await screen.findByRole('button', { name: 'Project' })
    expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Actions for Project' })).not.toBeInTheDocument()
    await user.keyboard('{Control>}'); await user.click(folder); await user.keyboard('{/Control}')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue(externalPath + '/Project'))
    await user.keyboard('{Delete}{Control>}z{/Control}')
    expect(screen.queryByRole('button', { name: /Delete|Undo|New folder/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(externalPath + '/Project'))
    expect(writes).toEqual([])
  })

  it('retains app-managed mutations for a bound Main root independently known to the folder service', async () => {
    const user = userEvent.setup()
    const input: BoundFolderBrowser['input'] = { workspaceId: 'workspace-1', hostRef: mainRoot.hostRef,
      allowedBaseId: mainRoot.bases[0]!.baseId, configurationRevision: '1', relativePath: '', accessMode: 'read-write',
      expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
    const writes: unknown[] = []
    server.use(
      http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => HttpResponse.json({
        workspaceId: 'workspace-1', selection: await request.json(),
        browse: { relativePath: '', directories: [{ name: 'Project', relativePath: 'Project' }], truncated: false },
      })),
      http.post('/api/management/harnesses/directories', async ({ request }) => {
        const body = await request.json() as { parentPath: string }
        writes.push(body)
        return HttpResponse.json({ value: { name: 'New folder', path: body.parentPath + '/New folder' }, replayed: false })
      }),
    )
    mount(undefined, false, '/projects/shared', { input, expectedHost: mainRoot })
    await openPicker(user)
    expect(await screen.findByRole('button', { name: 'Actions for Project' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    expect(await screen.findByRole('textbox', { name: 'Folder name' })).toHaveValue('New folder')
    expect(writes).toEqual([{ parentPath: '/projects/shared', commandId: expect.any(String) }])
    expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible()
  })

  it('Ctrl-clicks multiple folders without browsing and Delete removes the selected folders', async () => {
    const user = userEvent.setup()
    let directories = [{ name: 'Alpha', path: '/projects/Alpha' }, { name: 'Beta', path: '/projects/Beta' }]
    const writes: unknown[] = []
    server.use(
      http.get('/api/management/harnesses/directories', () => HttpResponse.json(page({ directories }))),
      http.post('/api/management/harnesses/directories/delete', async ({ request }) => {
        const input = await request.json() as { paths: string[] }
        writes.push(input); directories = directories.filter((entry) => !input.paths.includes(entry.path))
        return HttpResponse.json({ value: { deleted: input.paths, failed: [] }, replayed: false })
      }),
    )
    const { onSelect } = mount()
    await openPicker(user)
    await user.keyboard('{Control>}')
    await user.click(screen.getByRole('button', { name: 'Alpha' }))
    await user.click(screen.getByRole('button', { name: 'Beta' }))
    await user.keyboard('{/Control}')
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue('/projects')
    expect(screen.getByRole('button', { name: 'Select location' })).toBeDisabled()
    await user.keyboard('{Delete}')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument())
    expect(writes).toEqual([{ paths: ['/projects/Alpha', '/projects/Beta'], commandId: expect.any(String) }])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('uses the shared menu to rename an existing folder and saves when the name loses focus', async () => {
    const user = userEvent.setup()
    let folder = { name: 'Project', path: '/projects/Project' }
    const writes: unknown[] = []
    server.use(
      http.get('/api/management/harnesses/directories', () => HttpResponse.json(page({ directories: [folder] }))),
      http.post('/api/management/harnesses/directories/rename', async ({ request }) => {
        const input = await request.json() as { name: string }
        writes.push(input); folder = { name: input.name, path: '/projects/' + input.name }
        return HttpResponse.json({ value: folder, replayed: false })
      }),
    )
    mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Actions for Project' }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Folder name' })
    expect(input).toHaveFocus()
    await user.clear(input); await user.type(input, 'Renamed')
    await user.click(screen.getByRole('textbox', { name: 'Destination' }))
    expect(await screen.findByRole('button', { name: 'Renamed' })).toBeVisible()
    expect(writes).toEqual([{ path: '/projects/Project', name: 'Renamed', commandId: expect.any(String) }])
  })

  it('saves the new folder name on blur without assigning the workspace destination', async () => {
    const user = userEvent.setup()
    const writes: unknown[] = []
    server.use(http.post('/api/management/harnesses/directories/rename', async ({ request }) => {
      writes.push(await request.json())
      return HttpResponse.json({ value: { name: 'Blur saved', path: '/projects/Blur saved' }, replayed: false })
    }))
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    const input = await screen.findByRole('textbox', { name: 'Folder name' })
    await user.clear(input); await user.type(input, 'Blur saved')
    await user.click(screen.getByRole('textbox', { name: 'Destination' }))
    expect(await screen.findByRole('button', { name: 'Blur saved' })).toBeVisible()
    expect(writes).toHaveLength(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('creates in workspace storage immediately and focuses the real folder card name', async () => {
    const user = userEvent.setup()
    const writes: WorkspaceFolderCreateInput[] = []
    server.use(http.post('/api/management/harnesses/directories', async ({ request }) => {
      writes.push(await request.json() as WorkspaceFolderCreateInput)
      return HttpResponse.json({ value: { name: 'New folder', path: '/projects/New folder' }, replayed: false })
    }))
    const { onSelect } = mount(undefined, false, '/projects/Current')
    await user.click(screen.getByRole('button', { name: 'Project folder' }))
    await screen.findByRole('list', { name: 'Folders' })
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    const input = await screen.findByRole('textbox', { name: 'Folder name' })
    expect(input).toHaveFocus()
    expect(input).toHaveValue('New folder')
    expect(input).toHaveProperty('selectionStart', 0)
    expect(input).toHaveProperty('selectionEnd', 10)
    expect(screen.getByRole('list', { name: 'Folders' })).toContainElement(input)
    expect(writes).toEqual([{ parentPath: '/projects', commandId: expect.any(String) }])
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/New folder'))
  })

  it('opens inside workspace storage and updates the destination during browsing and Back', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount(undefined, false, '/projects/Current')
    await user.click(screen.getByRole('button', { name: 'Project folder' }))
    expect(await screen.findByRole('list', { name: 'Folders' })).toBeVisible()
    const destination = () => screen.getByRole('textbox', { name: 'Destination' })
    expect(destination()).toHaveValue('/projects')
    expect(screen.queryByRole('list', { name: 'Locations' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('dialog').querySelector('footer')).not.toContainElement(destination())
    await user.click(screen.getByRole('button', { name: 'Project' }))
    await waitFor(() => expect(destination()).toHaveValue('/projects/Project'))
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Project' })).toBeVisible()
    expect(destination()).toHaveValue('/projects')
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('uses a named folder list, a visible creation action, and a separate confirmation footer', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    const dialog = screen.getByRole('dialog', { name: 'Choose folder' })
    const list = within(dialog).getByRole('list', { name: 'Folders' })
    expect(within(list).getByRole('button', { name: 'Project' })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'New folder' })).toHaveTextContent('New folder')
    expect(within(dialog).getByRole('button', { name: 'Back' }).closest('header')).toContainElement(
      within(dialog).getByRole('heading', { name: 'Choose folder' }),
    )
    const footer = within(dialog).getByRole('button', { name: 'Select location' }).closest('footer')
    expect(footer).toContainElement(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(footer).not.toContainElement(list)
    expect(within(dialog).queryByRole('combobox', { name: 'Location' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not call a folder empty when only its subfolder listing is known', async () => {
    server.use(http.get('/api/management/harnesses/directories', () => HttpResponse.json(page({ directories: [] }))))
    const user = userEvent.setup()
    mount()
    await openPicker(user)
    expect(screen.queryByText('Empty folder')).not.toBeInTheDocument()
    expect(screen.queryByText('No subfolders.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled()
  })

  it.each(['Back', 'Escape'] as const)('returns focus to New folder after leaving the inline editor with %s', async (action) => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    const input = await screen.findByRole('textbox', { name: 'Folder name' })
    expect(input).toHaveFocus()
    await user.type(input, 'Unsubmitted folder')
    if (action === 'Back') await user.click(screen.getByRole('button', { name: 'Back' }))
    else await user.keyboard('{Escape}')
    await waitFor(() => expect(within(screen.getByRole('dialog').querySelector('.workspace-folder-toolbar') as HTMLElement).getByRole('button', { name: 'New folder' })).toHaveFocus())
    expect(screen.getByRole('dialog', { name: 'Choose folder' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not move focus from Cancel when the directory query refreshes', async () => {
    const user = userEvent.setup()
    const { client } = mount()
    await openPicker(user)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    act(() => cancel.focus())
    await act(async () => { await client.refetchQueries({ queryKey: harnessSettingsKeys.root }) })
    expect(cancel).toHaveFocus()
  })

  it('keeps root changes and paginated browsing reversible without committing a selection', async () => {
    const archive = { id: 'archive', label: 'Archive', path: '/archive' }
    const roots = [root, archive]
    const reads: Array<{ rootId: string | null; path: string | null; cursor: string | null }> = []
    server.use(http.get('/api/management/harnesses/directories', ({ request }) => {
      const query = new URL(request.url).searchParams
      reads.push({ rootId: query.get('rootId'), path: query.get('path'), cursor: query.get('cursor') })
      if (query.get('rootId') === archive.id) return HttpResponse.json(page({ roots, rootId: archive.id, path: archive.path, directories: [] }))
      if (query.get('path') === '/projects/Zeta') return HttpResponse.json(page({ roots, path: '/projects/Zeta', parent: root.path, directories: [] }))
      if (query.get('cursor') === 'page-2') return HttpResponse.json(page({ roots, directories: [{ name: 'Zeta', path: '/projects/Zeta' }] }))
      return HttpResponse.json(page({ roots, nextCursor: 'page-2' }))
    }))
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Next folders' }))
    await user.click(await screen.findByRole('button', { name: 'Zeta' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await screen.findByRole('button', { name: 'Zeta' })
    await user.click(screen.getByRole('button', { name: 'Locations' }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('list', { name: 'Locations' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Zeta' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Project' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(reads).toContainEqual({ rootId: root.id, path: root.path, cursor: 'page-2' })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('creates immediately and retries an uncertain creation with its original command identity', async () => {
    const writes: WorkspaceFolderCreateInput[] = []
    server.use(http.post('/api/management/harnesses/directories', async ({ request }) => {
      writes.push(await request.json() as WorkspaceFolderCreateInput)
      if (writes.length === 1) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Creation could not be confirmed.' } }, { status: 503 })
      return HttpResponse.json({ value: { name: 'New folder', path: '/projects/New folder' }, replayed: true })
    }))
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await screen.findByText('Creation could not be confirmed. Retry creation to resolve the same request.')
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry creation' }))
    const input = await screen.findByRole('textbox', { name: 'Folder name' })
    expect(input).toHaveValue('New folder')
    expect(input).toHaveFocus()
    expect(input).toHaveProperty('selectionStart', 0)
    expect(input).toHaveProperty('selectionEnd', 'New folder'.length)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ parentPath: root.path, commandId: expect.any(String) })
    expect(writes[1]).toEqual(writes[0])
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/New folder'))
  })

  it('keeps the modal open and blocks competing actions until saving finishes', async () => {
    const gate = deferred()
    const onSelect = vi.fn<(path: string) => Promise<void>>().mockReturnValue(gate.promise)
    const user = userEvent.setup()
    mount(onSelect)
    await openPicker(user)
    try {
      await user.click(screen.getByRole('button', { name: 'Select location' }))
      expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled()
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true')
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Close dialog' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Project' })).toBeDisabled()
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith(root.path)
    } finally { await act(async () => { gate.resolve(); await gate.promise }) }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Project folder' })).toHaveFocus()
  })

  it('resets browser history on reopen and keeps cancellation read-only', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Project' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await openPicker(user)
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Project' })).toBeVisible()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens a child with one click and confirms only with Select location', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    expect(screen.queryByRole('button', { name: 'Open Project' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Project' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue('/projects/Project'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select location' })).toBeEnabled())
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('/projects/Project'))
  })

  it('opens with keyboard activation and Back restores the parent destination', async () => {
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    act(() => screen.getByRole('button', { name: 'Project' }).focus())
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue('/projects/Project'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled())
    expect(onSelect).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByRole('button', { name: 'Project' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue('/projects')
  })

  it('inserts the name editor at its sorted position and Ctrl+Z removes the created folder', async () => {
    const user = userEvent.setup()
    let created = false
    let creationCommandId = ''
    let undoCalls = 0
    server.use(
      http.get('/api/management/harnesses/directories', () => HttpResponse.json(page({ directories: [
        { name: 'Alpha', path: '/projects/Alpha' },
        ...(created ? [{ name: 'New folder', path: '/projects/New folder' }] : []),
        { name: 'Zulu', path: '/projects/Zulu' },
      ] }))),
      http.post('/api/management/harnesses/directories', async ({ request }) => {
        creationCommandId = (await request.json() as WorkspaceFolderCreateInput).commandId
        created = true
        return HttpResponse.json({ value: { name: 'New folder', path: '/projects/New folder' }, replayed: false })
      }),
      http.post('/api/management/harnesses/directories/undo', async ({ request }) => {
        expect(await request.json()).toMatchObject({ creationCommandId })
        undoCalls++; created = false
        return HttpResponse.json({ value: { path: '/projects/New folder' }, replayed: false })
      }),
    )
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    const input = await screen.findByRole('textbox', { name: 'Folder name' })
    const rows = within(screen.getByRole('list', { name: 'Folders' })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Alpha')
    expect(rows[1]).toContainElement(input)
    expect(rows[2]).toHaveTextContent('Zulu')
    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).not.toBeInTheDocument())
    expect(undoCalls).toBe(1)
    expect(within(screen.getByRole('list', { name: 'Folders' })).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue('/projects')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps uncertain undo locked and retries the same command from the footer shortcut', async () => {
    const writes: unknown[] = []
    server.use(http.post('/api/management/harnesses/directories/undo', async ({ request }) => {
      writes.push(await request.json())
      return writes.length === 1
        ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Undo not confirmed.' } }, { status: 503 })
        : HttpResponse.json({ value: { path: '/projects/New folder' }, replayed: true })
    }))
    const user = userEvent.setup()
    const { onSelect } = mount()
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'New folder' }))
    await screen.findByRole('textbox', { name: 'Folder name' })
    act(() => screen.getByRole('button', { name: 'Select location' }).focus())
    await user.keyboard('{Control>}z{/Control}')
    await screen.findByRole('button', { name: 'Retry undo' })
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select location' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Retry undo' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Folder name' })).not.toBeInTheDocument())
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual(writes[0])
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('keeps a selected folder editable after a definitive save rejection', async () => {
    const onSelect = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Destination rejected.')).mockResolvedValue(undefined)
    const user = userEvent.setup()
    mount(onSelect)
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Project' }))
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Destination rejected.')
    expect(screen.getByRole('textbox', { name: 'Destination' })).toHaveValue('/projects/Project')
    await user.click(screen.getByRole('button', { name: 'Select location' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onSelect.mock.calls).toEqual([['/projects/Project'], ['/projects/Project']])
  })

})
