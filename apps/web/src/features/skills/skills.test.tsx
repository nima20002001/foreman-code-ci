import type { ReactNode } from 'react'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssignedSkill } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { assignSkillUser, editSkillElsewhere, seedSkill } from '../../shared/mocks/skillsHandlers'
import { SkillsLibrary, type SkillLibrarySearch } from './SkillsLibrary'
import { SkillEditor, type SavedSkill } from './SkillEditor'
import { NewSkillPage, SkillDetailPage } from './SkillPages'
import { AgentSkillsField } from './AgentSkillsField'
import { readSkillFile } from './skillImport'
import { deferred } from '../../test/deferred'

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, className, params }: {
  children: ReactNode; className?: string; params?: { workspaceId: string; skillId: string }
}) => <a href={params ? `/settings/skills/${params.workspaceId}/${params.skillId}` : '#'}
  className={className}>{children}</a> }))

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return { client, ...render(<QueryClientProvider client={client}>{node}</QueryClientProvider>) }
}
const workspaces = [{ value: 'workspace-a', label: 'Alpha' }, { value: 'workspace-b', label: 'Beta' }]
function Library({ initial = {} }: { initial?: SkillLibrarySearch }) {
  const [search, setSearch] = useState(initial)
  return <SkillsLibrary search={search} onSearchChange={setSearch} />
}
async function saved(workspaceId: string, skillId: string): Promise<SavedSkill> {
  return await (await fetch(new URL(`/api/management/workspaces/${workspaceId}/skills/${skillId}`, location.origin))).json() as SavedSkill
}
function requests(method: string, fragment: string) {
  const seen: Request[] = []
  server.events.on('request:start', ({ request }) => { if (request.method === method && request.url.includes(fragment)) seen.push(request.clone()) })
  return seen
}

describe('Settings → Skills library', () => {
  it('keeps the newest row across overlapping pages and scopes equal skill IDs by workspace', async () => {
    const user = userEvent.setup()
    const first = seedSkill('workspace-a', 'Early name', 'First', { skillId: 'shared-guide' })
    const foreign = seedSkill('workspace-b', 'Other workspace guide', 'Other', { skillId: 'shared-guide' })
    const renamed = { ...first, name: 'Renamed guide', version: '2', revision: 2, versionCount: 2 }
    server.use(http.get('/api/management/skills', ({ request }) => {
      const next = new URL(request.url).searchParams.has('cursor')
      return HttpResponse.json({ items: next ? [renamed, first, foreign] : [first],
        pageInfo: { nextCursor: next ? null : 'second-page' } })
    }))
    wrap(<Library />)
    expect(await screen.findByText('Early name')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Show more skills' }))
    expect(await screen.findByText('Renamed guide')).toBeVisible()
    expect(screen.queryByText('Early name')).toBeNull()
    expect(within(screen.getByRole('list', { name: 'Skills' })).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('2 skills shown')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Renamed guide/ })).toHaveAttribute('href',
      '/settings/skills/workspace-a/shared-guide')
    expect(screen.getByRole('link', { name: /Other workspace guide/ })).toHaveAttribute('href',
      '/settings/skills/workspace-b/shared-guide')
  })

  it('shows loading, then one row per logical skill; never a false empty list while loading', async () => {
    seedSkill('workspace-1', 'Reviewer', 'Review carefully.', { description: 'Checks diffs' })
    const response = deferred<void>()
    server.use(http.get('/api/management/skills', async () => {
      await response.promise
      return undefined
    }, { once: true }))
    wrap(<Library />)
    expect(screen.getByText('Loading skills…')).toBeInTheDocument()
    expect(screen.queryByText('No skills yet')).not.toBeInTheDocument()
    await act(async () => { response.resolve(undefined) })
    expect(await screen.findByText('Reviewer')).toBeVisible()
    expect(screen.getByText('Checks diffs')).toBeVisible()
    expect(screen.getByText('Active · v1')).toBeVisible()
  })

  it('separates a true empty library, an empty search, and a load failure with retry', async () => {
    const user = userEvent.setup()
    wrap(<Library />)
    expect(await screen.findByText('No skills yet')).toBeVisible()
    cleanup()
    seedSkill('workspace-1', 'Reviewer', 'Body')
    wrap(<Library initial={{ q: 'nothing-matches' }} />)
    expect(await screen.findByText('No skills match')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByText('Reviewer')).toBeVisible()
    cleanup()
    server.use(http.get('/api/management/skills', () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Database unavailable.' } }, { status: 503 }), { once: true }))
    wrap(<Library />)
    expect(await screen.findByText('Skills could not be loaded')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Reviewer')).toBeVisible()
  })

  it('never shows another workspace\'s skills while a new workspace filter loads', async () => {
    const user = userEvent.setup()
    seedSkill('workspace-a', 'Alpha only', 'A')
    seedSkill('workspace-b', 'Beta only', 'B')
    server.use(http.get('/api/management/workspaces', () => HttpResponse.json({ items: [
      { workspace: { id: 'workspace-a', name: 'Alpha' }, revision: 0, archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } },
      { workspace: { id: 'workspace-b', name: 'Beta' }, revision: 0, archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } },
    ], pageInfo: { nextCursor: null } })))
    wrap(<Library initial={{ workspace: 'workspace-a' }} />)
    expect(await screen.findByText('Alpha only')).toBeVisible()
    const response = deferred<void>()
    server.use(http.get('/api/management/skills', async () => {
      await response.promise
      return undefined
    }, { once: true }))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Workspace' }), 'workspace-b')
    expect(screen.queryByText('Alpha only')).not.toBeInTheDocument()
    await act(async () => { response.resolve(undefined) })
    expect(await screen.findByText('Beta only')).toBeVisible()
  })

  it('hides archived skills unless asked and filters by search text', async () => {
    const user = userEvent.setup()
    seedSkill('workspace-1', 'Active guide', 'A')
    seedSkill('workspace-1', 'Old guide', 'B', { archived: true })
    wrap(<Library />)
    expect(await screen.findByText('Active guide')).toBeVisible()
    expect(screen.queryByText('Old guide')).not.toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Show archived' }))
    expect(await screen.findByText('Old guide')).toBeVisible()
    expect(screen.getByText('Archived · v1')).toBeVisible()
    await user.type(screen.getByRole('searchbox', { name: 'Search skills' }), 'active')
    await waitFor(() => expect(screen.queryByText('Old guide')).not.toBeInTheDocument())
  })
})

describe('Skills simplified screens', () => {
  function assignedAgents(skillId: string) {
    server.use(http.get('/api/management/workspaces/:workspaceId/agents', ({ params }) =>
      HttpResponse.json({ items: params.workspaceId === 'workspace-a' ? [
        { agent: { id: 'reviewer', name: 'Reviewer', assignedSkills: [{ skillId, version: '1' }] }, metadataRevision: 1 },
        { agent: { id: 'writer', name: 'Writer', assignedSkills: [] }, metadataRevision: 1 },
      ] : [], pageInfo: { nextCursor: null } })))
  }

  it('shows status and assigned Agents in one linked row, including assignments on the latest version', async () => {
    const skill = seedSkill('workspace-a', 'Review guide', 'Review carefully.')
    assignedAgents(skill.skillId)
    wrap(<Library />)
    const row = await screen.findByRole('link', { name: /Review guide/ })
    expect(await within(row).findByText('Reviewer')).toBeVisible()
    expect(within(row).getByText('Active · v1')).toBeVisible()
    expect(within(row).queryByText('Writer')).toBeNull()
    expect(row).toHaveAttribute('href', `/settings/skills/workspace-a/${skill.skillId}`)
    expect(screen.getAllByRole('link', { name: 'Add skill' })).toHaveLength(1)
  })

  it('keeps assignment failures distinct from an unassigned skill and supports retry', async () => {
    const user = userEvent.setup()
    const skill = seedSkill('workspace-a', 'Review guide', 'Review carefully.')
    assignedAgents(skill.skillId)
    server.use(http.get('/api/management/workspaces/:workspaceId/agents', () =>
      HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Agents unavailable.' } }, { status: 503 }), { once: true }))
    wrap(<Library />)
    const row = await screen.findByRole('listitem')
    expect(await within(row).findByText('Assignments unavailable')).toBeVisible()
    expect(within(row).queryByText('No Agents')).toBeNull()
    await user.click(within(row).getByRole('button', { name: 'Retry assignments' }))
    expect(await within(row).findByText('Reviewer')).toBeVisible()
  })

  it('opens version history on demand and previews the selected immutable version', async () => {
    const user = userEvent.setup()
    const skill = seedSkill('workspace-a', 'Guide', 'First instructions')
    editSkillElsewhere('workspace-a', skill.skillId, 'Second instructions')
    wrap(<SkillDetailPage workspaceId="workspace-a" skillId={skill.skillId} onCancel={vi.fn()} />)
    expect(await screen.findByRole('textbox', { name: /^Instructions/ })).toHaveValue('Second instructions')
    const history = screen.getByRole('button', { name: 'Version history' })
    expect(history).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'View version 1' })).toBeNull()
    await user.click(history)
    expect(history).toHaveAttribute('aria-expanded', 'true')
    await user.click(await screen.findByRole('button', { name: 'View version 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Version 1' })
    expect(await within(dialog).findByLabelText('Instructions preview')).toHaveTextContent('First instructions')
    expect(within(dialog).queryByText('Second instructions')).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    expect(screen.getByRole('textbox', { name: /^Instructions/ })).toHaveValue('Second instructions')
    await user.click(history)
    expect(screen.queryByRole('button', { name: 'View version 1' })).toBeNull()
  })

  it('keeps the new skill form focused on fields, import, preview and create', async () => {
    seedSkill('workspace-a', 'Existing', 'Instructions')
    wrap(<NewSkillPage onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByRole('heading', { name: 'New skill' })).toBeVisible()
    expect(await screen.findByRole('combobox', { name: /Workspace/ })).toBeVisible()
    expect(screen.getByRole('textbox', { name: /^Name/ })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: /^Instructions/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Import Markdown file' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Preview' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Create skill' })).toBeVisible()
    expect(screen.queryByText('Drop a Markdown or text file here to import.')).toBeNull()
  })

  it('keeps archived instructions readable and restores editing through the existing action', async () => {
    const user = userEvent.setup()
    const skill = seedSkill('workspace-a', 'Archived guide', 'Kept instructions', { archived: true })
    wrap(<SkillDetailPage workspaceId="workspace-a" skillId={skill.skillId} onCancel={vi.fn()} />)
    const instructions = await screen.findByRole('textbox', { name: /^Instructions/ })
    expect(instructions).toHaveAttribute('readonly')
    expect(instructions).toHaveValue('Kept instructions')
    expect(screen.queryByRole('button', { name: 'Save new version' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Restore skill' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Restore Archived guide?' })
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(instructions).not.toHaveAttribute('readonly'))
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeDisabled()
    expect((await saved('workspace-a', skill.skillId)).skill.archived).toBe(false)
  })
})

describe('Skill editor', () => {
  it('validates required fields, focuses the first problem and keeps the draft', async () => {
    const user = userEvent.setup()
    const posts = requests('POST', '/skills')
    wrap(<SkillEditor workspaceOptions={workspaces} onSaved={vi.fn()} onCancel={vi.fn()} />)
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Kept')
    await user.click(screen.getByRole('button', { name: 'Create skill' }))
    expect(await screen.findByText('Choose the workspace that owns this skill.')).toBeVisible()
    expect(screen.getByRole('combobox', { name: /Workspace/ })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Kept')
    expect(posts).toHaveLength(0)
  })

  it('creates once even when Save is double-clicked, preserving the literal instruction text', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    const posts = requests('POST', '/skills')
    const response = deferred<void>()
    server.use(http.post('/api/management/workspaces/:workspaceId/skills', async () => {
      await response.promise
      return undefined
    }))
    wrap(<SkillEditor workspaceOptions={workspaces} initialWorkspace="workspace-b" onSaved={onSaved} onCancel={vi.fn()} />)
    await user.type(screen.getByRole('textbox', { name: /^Name/ }), 'Écrivain ✓')
    await user.type(screen.getByRole('textbox', { name: /^Instructions/ }), '  # Title{Enter}{Enter}- keep  ')
    const save = screen.getByRole('button', { name: 'Create skill' })
    await user.dblClick(save)
    expect(save).toBeDisabled()
    await act(async () => { response.resolve(undefined) })
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(posts).toHaveLength(1)
    const body = await posts[0]!.json() as { workspaceId: string; instructions: string }
    expect(body).toMatchObject({ workspaceId: 'workspace-b', instructions: '  # Title\n\n- keep  ' })
    expect(onSaved.mock.calls[0]![0].version.instructions).toBe('  # Title\n\n- keep  ')
  })

  it('saves an edit as a new version; an unchanged form cannot be saved', async () => {
    const user = userEvent.setup()
    const summary = seedSkill('workspace-a', 'Guide', 'Version one')
    const initial = await saved('workspace-a', summary.skillId)
    wrap(<SkillEditor saved={initial} workspaceOptions={[]} onSaved={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeDisabled()
    const instructions = screen.getByRole('textbox', { name: /^Instructions/ })
    await user.clear(instructions); await user.type(instructions, 'Version two')
    await user.click(screen.getByRole('button', { name: 'Save new version' }))
    expect(await screen.findByText('Saved as version 2.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeDisabled()
  })

  it('shows a recoverable conflict after a concurrent save and never overwrites silently', async () => {
    const user = userEvent.setup()
    const summary = seedSkill('workspace-a', 'Guide', 'Base')
    const initial = await saved('workspace-a', summary.skillId)
    editSkillElsewhere('workspace-a', summary.skillId, 'Saved by the Operator')
    wrap(<SkillEditor saved={initial} workspaceOptions={[]} onSaved={vi.fn()} onCancel={vi.fn()} />)
    const instructions = screen.getByRole('textbox', { name: /^Instructions/ })
    await user.clear(instructions); await user.type(instructions, 'My edit')
    await user.click(screen.getByRole('button', { name: 'Save new version' }))
    expect(await screen.findByText('This skill changed since you opened it. Nothing was saved.')).toBeVisible()
    expect(instructions).toHaveValue('My edit')
    expect((await saved('workspace-a', summary.skillId)).version.instructions).toBe('Saved by the Operator')
    await user.click(screen.getByRole('button', { name: 'Save my edits as a new version' }))
    await waitFor(async () => expect((await saved('workspace-a', summary.skillId)).version).toMatchObject({ version: '3', instructions: 'My edit' }))
  })

  it('after a conflict, loads the newer saved version on request', async () => {
    const user = userEvent.setup()
    const summary = seedSkill('workspace-a', 'Guide', 'Base')
    wrap(<SkillDetailPage workspaceId="workspace-a" skillId={summary.skillId} onCancel={vi.fn()} />)
    const instructions = await screen.findByRole('textbox', { name: /^Instructions/ })
    await user.clear(instructions); await user.type(instructions, 'Mine')
    editSkillElsewhere('workspace-a', summary.skillId, 'Theirs')
    await user.click(screen.getByRole('button', { name: 'Save new version' }))
    expect(await screen.findByText('This skill changed since you opened it. Nothing was saved.')).toBeVisible()
    expect(instructions).toHaveValue('Mine')
    const load = screen.getByRole('button', { name: 'Discard my edits and load latest' })
    await waitFor(() => expect(load).toBeEnabled())
    await user.click(load)
    expect(instructions).toHaveValue('Theirs')
  })

  it('keeps the command identity after a lost response so Retry cannot publish twice', async () => {
    const user = userEvent.setup()
    const summary = seedSkill('workspace-a', 'Guide', 'Base')
    const initial = await saved('workspace-a', summary.skillId)
    const patches = requests('PATCH', summary.skillId)
    let lose = true
    server.use(http.patch('/api/management/workspaces/:workspaceId/skills/:skillId', () => {
      if (lose) { lose = false; return HttpResponse.error() }
      return undefined
    }))
    wrap(<SkillEditor saved={initial} workspaceOptions={[]} onSaved={vi.fn()} onCancel={vi.fn()} />)
    const instructions = screen.getByRole('textbox', { name: /^Instructions/ })
    await user.clear(instructions); await user.type(instructions, 'Once')
    await user.click(screen.getByRole('button', { name: 'Save new version' }))
    expect(await screen.findByText(/The last save may have been stored/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Retry save' }))
    expect(await screen.findByText('Saved as version 2.')).toBeVisible()
    const ids = await Promise.all(patches.map(async (request) => (await request.json() as { commandId: string }).commandId))
    expect(new Set(ids).size).toBe(1)
  })

  it('does not reset a dirty editor when the skill changes elsewhere, and adopts it when clean', async () => {
    const user = userEvent.setup()
    const summary = seedSkill('workspace-a', 'Guide', 'Base')
    const { client } = wrap(<SkillDetailPage workspaceId="workspace-a" skillId={summary.skillId} onCancel={vi.fn()} />)
    const instructions = await screen.findByRole('textbox', { name: /^Instructions/ })
    await user.clear(instructions); await user.type(instructions, 'Local draft')
    editSkillElsewhere('workspace-a', summary.skillId, 'Remote v2')
    await act(async () => { await client.invalidateQueries() })
    expect(await screen.findByText(/saved elsewhere as version 2/)).toBeVisible()
    expect(instructions).toHaveValue('Local draft')
    await user.click(screen.getByRole('button', { name: 'Discard my edits and load it' }))
    expect(instructions).toHaveValue('Remote v2')
    editSkillElsewhere('workspace-a', summary.skillId, 'Remote v3')
    await act(async () => { await client.invalidateQueries() })
    await waitFor(() => expect(instructions).toHaveValue('Remote v3'))
  })

  it('previews text literally without rendering HTML or loading remote content', async () => {
    const user = userEvent.setup()
    wrap(<SkillEditor workspaceOptions={workspaces} onSaved={vi.fn()} onCancel={vi.fn()} />)
    const text = '<img src="https://example.invalid/x.png" onerror="alert(1)"><script>alert(2)</script>'
    await user.click(screen.getByRole('textbox', { name: /^Instructions/ }))
    await user.paste(text)
    await user.click(screen.getByRole('tab', { name: 'Preview' }))
    const preview = screen.getByLabelText('Instructions preview')
    expect(preview).toHaveTextContent(text)
    expect(preview.querySelector('img, script')).toBeNull()
  })

  it('imports one Markdown file into the unsaved editor only after preview', async () => {
    const user = userEvent.setup()
    const posts = requests('POST', '/skills')
    const { container } = wrap(<SkillEditor workspaceOptions={workspaces} onSaved={vi.fn()} onCancel={vi.fn()} />)
    const input = container.querySelector<HTMLInputElement>('input[type=file]')!
    await user.upload(input, new File(['# Imported\n\nUse care.'], 'code-review.md', { type: 'text/markdown' }))
    const dialog = await screen.findByRole('dialog', { name: 'Use imported instructions?' })
    expect(within(dialog).getByLabelText('Instructions preview')).toHaveTextContent('# Imported')
    await user.click(within(dialog).getByRole('button', { name: 'Use this text' }))
    expect(screen.getByRole('textbox', { name: /^Instructions/ })).toHaveValue('# Imported\n\nUse care.')
    expect(screen.getByRole('textbox', { name: /^Name/ })).toHaveValue('code-review')
    expect(posts).toHaveLength(0)
  })

  it('drops Markdown through the import preview without overwriting or saving the draft', async () => {
    const user = userEvent.setup(), posts = requests('POST', '/skills')
    const { container } = wrap(<SkillEditor workspaceOptions={workspaces} onSaved={vi.fn()} onCancel={vi.fn()} />)
    await user.type(screen.getByRole('textbox', { name: /^Instructions/ }), 'Keep my draft')
    fireEvent.drop(container.querySelector('.skill-instructions')!, { dataTransfer: {
      types: ['Files'], files: [new File(['# Drop instructions'], 'dropped.md', { type: 'text/markdown' })],
    } })
    const dialog = await screen.findByRole('dialog', { name: 'Use imported instructions?' })
    expect(screen.getByRole('textbox', { name: /^Instructions/ })).toHaveValue('Keep my draft')
    expect(within(dialog).getByLabelText('Instructions preview')).toHaveTextContent('# Drop instructions')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('textbox', { name: /^Instructions/ })).toHaveValue('Keep my draft')
    expect(posts).toHaveLength(0)
  })

  it('rejects invalid UTF-8, packages and empty files', async () => {
    expect(await readSkillFile(new File([new Uint8Array([0xff, 0xfe, 0xfd])], 'bad.md'))).toEqual({ error: 'This file is not valid UTF-8 text.' })
    expect(await readSkillFile(new File(['x'], 'skill.zip'))).toMatchObject({ error: expect.stringContaining('single Markdown') })
    expect(await readSkillFile(new File(['   '], 'empty.md'))).toEqual({ error: 'This file is empty.' })
  })
})

describe('Board Agent skill assignment', () => {
  function Field({ initial = [] as AssignedSkill[], onChange = vi.fn() }) {
    const [value, setValue] = useState(initial)
    return <AgentSkillsField workspaceId="workspace-a" value={value} onChange={(next) => { setValue(next); onChange(next) }} />
  }
  it('previews and assigns the catalog version after another caller publishes a new head', async () => {
    const user = userEvent.setup()
    const skill = seedSkill('workspace-a', 'Guide', 'Instructions from version one', { skillId: 'shared-guide' })
    seedSkill('workspace-b', 'Foreign guide', 'Foreign instructions', { skillId: 'shared-guide' })
    const onChange = vi.fn()
    wrap(<Field onChange={onChange} />)
    await user.click(await screen.findByRole('button', { name: 'Add' }))
    expect(screen.queryByText('Selected skills are added in the order you pick them. Each keeps its current version until you update it.')).toBeNull()
    editSkillElsewhere('workspace-a', skill.skillId, 'Instructions from version two')
    await user.click(screen.getByRole('button', { name: 'Preview Guide' }))
    expect(await screen.findByLabelText('Instructions preview')).toHaveTextContent('Instructions from version one')
    expect(screen.queryByText('Instructions from version two')).toBeNull()
    expect(screen.queryByText('Foreign instructions')).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: 'Guide' }))
    await user.click(screen.getByRole('button', { name: 'Add 1 skill' }))
    expect(onChange).toHaveBeenLastCalledWith([{ skillId: skill.skillId, version: '1' }])
  })

  it('adds several skills in picked order, reorders, removes and offers an explicit newer version', async () => {
    const user = userEvent.setup()
    const first = seedSkill('workspace-a', 'First', 'One')
    const second = seedSkill('workspace-a', 'Second', 'Two')
    seedSkill('workspace-b', 'Foreign', 'Other workspace')
    const onChange = vi.fn()
    wrap(<Field onChange={onChange} />)
    await user.click(await screen.findByRole('button', { name: 'Add' }))
    expect(screen.queryByText('Foreign')).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /^Second/ }))
    await user.click(screen.getByRole('checkbox', { name: /^First/ }))
    await user.click(screen.getByRole('button', { name: 'Add 2 skills' }))
    expect(onChange).toHaveBeenLastCalledWith([{ skillId: second.skillId, version: '1' }, { skillId: first.skillId, version: '1' }])
    await user.click(screen.getByRole('button', { name: 'Move First up' }))
    expect(onChange).toHaveBeenLastCalledWith([{ skillId: first.skillId, version: '1' }, { skillId: second.skillId, version: '1' }])
    await user.click(screen.getByRole('button', { name: 'Remove Second' }))
    expect(onChange).toHaveBeenLastCalledWith([{ skillId: first.skillId, version: '1' }])
  })

  it('never follows a newer version automatically and keeps the selection when the catalog fails', async () => {
    const user = userEvent.setup()
    const skill = seedSkill('workspace-a', 'Pinned', 'v1')
    editSkillElsewhere('workspace-a', skill.skillId, 'v2')
    const onChange = vi.fn()
    wrap(<Field initial={[{ skillId: skill.skillId, version: '1' }]} onChange={onChange} />)
    expect(await screen.findByText('Version 1')).toBeVisible()
    await user.click(await screen.findByRole('button', { name: 'Use version 2' }))
    expect(onChange).toHaveBeenLastCalledWith([{ skillId: skill.skillId, version: '2' }])
    cleanup()
    server.use(http.get('/api/management/skills', () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Down' } }, { status: 503 })))
    wrap(<Field initial={[{ skillId: skill.skillId, version: '1' }]} />)
    expect(await screen.findByText('Skills could not be loaded. Your selection is unchanged.')).toBeVisible()
    expect(screen.getByText(skill.skillId)).toBeVisible()
  })
})

describe('Skill users', () => {
  it('offers workflow-only recovery after mounting with no outdated Agents', async () => {
    const user = userEvent.setup()
    const skill = seedSkill('workspace-a', 'Reviewer', 'First')
    editSkillElsewhere('workspace-a', skill.skillId, 'Second')
    let updated = false
    server.use(
      http.get('/api/management/workspaces/:workspaceId/skills/:skillId/usage', () => HttpResponse.json({
        skillId: skill.skillId, headVersion: '2', agents: [],
        workflows: updated ? [] : [{ workflowId: 'website', name: 'Website' }],
      })),
      http.post('/api/management/workspaces/:workspaceId/skills/:skillId/update-users', () => {
        updated = true
        return HttpResponse.json({ headVersion: '2', agents: [], failed: [],
          workflows: [{ workflowId: 'website', workflowVersionId: 'website-updated' }] })
      }),
    )
    wrap(<SkillDetailPage workspaceId="workspace-a" skillId={skill.skillId} onCancel={vi.fn()} />)
    expect(await screen.findByText('1 workflow still uses an older version')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Update to v2' }))
    await waitFor(() => expect(screen.queryByText(/still uses an older version/)).toBeNull())
    expect(updated).toBe(true)
  })

  it('shows a failed usage read and recovers through its retry action while detail stays available', async () => {
    const user = userEvent.setup()
    const skill = seedSkill('workspace-a', 'Reviewer', 'First')
    assignSkillUser('workspace-a', skill.skillId, { agentId: 'coder', name: 'Coder', version: '1', workflows: [] })
    editSkillElsewhere('workspace-a', skill.skillId, 'Second')
    server.use(http.get('/api/management/workspaces/:workspaceId/skills/:skillId/usage', () =>
      HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Usage unavailable.' } }, { status: 503 }), { once: true }))
    wrap(<SkillDetailPage workspaceId="workspace-a" skillId={skill.skillId} onCancel={vi.fn()} />)
    expect(await screen.findByRole('textbox', { name: /^Instructions/ })).toHaveValue('Second')
    expect(await screen.findByText('Skill usage could not be loaded.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('1 Agent still uses an older version')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Update to v2' })).toBeEnabled()
  })

  it('offers one click to move Agents and their workflows to the saved version', async () => {
    const user = userEvent.setup()
    const summary = seedSkill('workspace-a', 'Reviewer', 'First')
    assignSkillUser('workspace-a', summary.skillId, { agentId: 'coder', name: 'Coder', version: '1',
      workflows: [{ workflowId: 'website', name: 'Website' }] })
    wrap(<SkillDetailPage workspaceId="workspace-a" skillId={summary.skillId} onCancel={vi.fn()} />)
    const instructions = await screen.findByRole('textbox', { name: /^Instructions/ })
    expect(screen.queryByText(/still use an older version/)).toBeNull()
    await user.clear(instructions); await user.type(instructions, 'Second')
    await user.click(screen.getByRole('button', { name: 'Save new version' }))
    expect(await screen.findByText('1 Agent and 1 workflow still use an older version')).toBeVisible()
    expect(screen.getByText('Coder (v1)')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Update to v2' }))
    await waitFor(() => expect(screen.queryByText(/still use an older version/)).toBeNull())
  })
})
