import { isInaccessible, queryAllByAttribute, queryByAttribute, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect } from 'vitest'
import { HttpResponse } from 'msw'
import { GraphEditAdvanceInputV3Schema, GraphEditStageInputV3Schema,
  type GraphEditIntentV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../graph/store'
import { fixture as authoringFixture } from '../graph/nextDraft/core.cases'
import { graphEditIntentKey } from '../graph/nextDraft/useGraphEditIntent'
import { journalIntent, savedJournal } from '../graph/nextDraft/nim2644Journal.fixture'
import { measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'
import { meaningfulSaveFixture } from './meaningfulSave.testSupport'

export type Fixture = Awaited<ReturnType<typeof recoveryFixture>>
export const draft = (f: Fixture) => useGraphDraftStore.getState().nextDrafts[f.key]!

/** The one element with this exact aria-label. Role and label-text queries over the
 * whole mounted Board cost seconds each in jsdom, so these tests find named landmarks
 * by attribute and run role and label queries only inside them. */
export function labelled(name: string, root: HTMLElement = document.body) {
  const found = queryAllByAttribute('aria-label', root, name)
  if (found.length !== 1) throw new Error(`Expected one element labelled "${name}", found ${found.length}`)
  return found[0]!
}
export const authoringRegion = () => labelled('Workflow authoring')
export const authoring = () => within(authoringRegion())
export const toolbar = (name: 'Draft actions' | 'Workflow controls') => within(labelled(name, authoringRegion()))
export const recovery = () => within(labelled('Draft conflict recovery'))
export const hierarchyForm = () => within(labelled('Master hierarchy'))
export const agentList = () => within(labelled('Agents and connections', authoringRegion()))
export const rail = () => within(labelled('Workflow side panel'))
export const queryLabelled = (name: string) => queryByAttribute('aria-label', document.body, name)
/** The accessible dialog titled `name`, as getByRole(role, { name }) would return it. */
export function queryDialog(name: string, role: 'dialog' | 'alertdialog' = 'dialog') {
  const found = Array.from(document.querySelectorAll<HTMLElement>(`[role="${role}"]`)).filter(element => !isInaccessible(element)
    && document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent === name)
  if (found.length > 1) throw new Error(`Found ${found.length} ${role} elements named "${name}"`)
  return found[0] ?? null
}
export const findDialog = (name: string, role: 'dialog' | 'alertdialog' = 'dialog') => waitFor(() => {
  const element = queryDialog(name, role)
  if (!element) throw new Error(`No ${role} named "${name}"`)
  return element
})

/** Only HTTP replies are simulated. The mounted router, editor, storage,
 * private-command journal client and fresh transport base are production code. */
export async function recoveryFixture(source = authoringFixture()) {
  const f = await meaningfulSaveFixture(false, source)
  let saved = structuredClone(f.definition())
  const baseManaged = f.mock.managed(f.workflowId)
  const intents = new Map<string, GraphEditIntentV3>(), requests: GraphEditStageInputV3[] = []
  const controls = { failLatestRead: false, loseStageReply: false }
  const read = (draftId: string) => ({ intent: intents.get(draftId) ?? null, current: [], canStop: true, affectedSetChanged: false })
  const reply = async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && (url.pathname === f.path || url.pathname === `${f.path}/definition`)) {
      if (controls.failLatestRead) return HttpResponse.json({ error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Latest saved workflow could not be read.' } }, { status: 503 })
      return HttpResponse.json(url.pathname === f.path ? { ...baseManaged, workflow: saved.version.definition,
        revision: saved.revision, currentVersionId: saved.currentVersionId } : saved)
    }
    if (url.pathname !== `${f.path}/definition/edits`) return undefined
    if (request.method === 'GET') return HttpResponse.json(read(url.searchParams.get('draftId') ?? ''))
    const raw: unknown = await request.json()
    if ((raw as { action?: string }).action === 'stage_edits') {
      const input = GraphEditStageInputV3Schema.parse(raw); requests.push(structuredClone(input))
      const prior = intents.get(input.draftId)
      if (prior?.stageCommandId === input.commandId) return HttpResponse.json(read(input.draftId))
      if (input.expectedRevision !== saved.revision || input.expectedWorkflowVersionId !== saved.currentVersionId) {
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'The saved workflow changed. Inspect latest to compare your draft.' } }, { status: 409 })
      }
      const context = { draft: { ...f.mock.drafts.get(f.workflowId)!, graph: saved.version.definition,
        revision: saved.revision, publishedRevision: saved.revision, baseWorkflowVersionId: saved.currentVersionId }, agents: f.mock.catalog }
      intents.set(input.draftId, journalIntent(input, context))
      if (controls.loseStageReply) { controls.loseStageReply = false; return HttpResponse.error() }
      return HttpResponse.json(read(input.draftId))
    }
    const input = GraphEditAdvanceInputV3Schema.parse(raw), intent = intents.get(input.draftId)!
    expect(input.intentId).toBe(intent.id); expect(input.commandId).toBe(intent.advanceCommandId)
    if (intent.state !== 'saved') {
      const completed = savedJournal(intent, saved.version.version + 1)
      intents.set(input.draftId, completed)
      const result = completed.result!
      saved = { workspaceId: result.workspaceId, workflowId: result.workflowId, revision: result.revision,
        currentVersionId: result.currentVersionId, version: result.version }
    }
    return HttpResponse.json(read(input.draftId))
  }
  const externalEdit = (name: string) => {
    const version = saved.version.version + 1, id = `external-version-${version}`
    saved = { ...saved, revision: saved.revision + 1, currentVersionId: id,
      version: { ...saved.version, id, version, definition: { ...saved.version.definition, version, name } } }
  }
  const wire = measureBoardWire(f.mock, reply)
  return { ...f, controls, requests, externalEdit, wire, saved: () => saved }
}
export async function mount(f: Fixture) {
  const view = await mountMeasuredBoard(f.href)
  await waitFor(() => authoringRegion())
  await waitFor(() => expect(draft(f)).toBeDefined())
  await waitFor(() => expect(view.cache.getQueryState(graphEditIntentKey(f.workspaceId, f.workflowId,
    draft(f).context.draft.id))).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
  return view
}
export async function rename(name: string) {
  await userEvent.click(authoring().getByTitle('Rename workflow'))
  const field = labelled('Workflow name', authoringRegion())
  await userEvent.clear(field); await userEvent.type(field, `${name}{Enter}`)
  await userEvent.click(within(await findDialog('Rename workflow?')).getByRole('button', { name: 'Rename' }))
}
export async function settings() {
  if (!queryLabelled('Draft conflict recovery')) await userEvent.click(toolbar('Workflow controls').getByRole('button', { name: 'Workflow settings' }))
  return waitFor(() => labelled('Draft conflict recovery'))
}
