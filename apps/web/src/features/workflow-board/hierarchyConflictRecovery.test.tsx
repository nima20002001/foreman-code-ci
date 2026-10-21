// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftDirty } from '../graph/nextDraft/state'
import { readConflictRecoveries, readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { installBoardTestLifecycle } from './eng05D.testSupport'
import { authoring, draft, findDialog, labelled, mount, queryDialog, recovery, recoveryFixture, rename, settings,
  toolbar } from './hierarchyRecovery.testSupport'

installBoardTestLifecycle()

it('opens latest into a fresh durable base after a rejected save and saves only a manually reapplied change', async () => {
  const f = await recoveryFixture(); await mount(f)
  const originalId = draft(f).context.draft.id, originalVersion = draft(f).context.draft.baseWorkflowVersionId
  await rename('My first unsaved name')
  f.externalEdit('Other saved name')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  const rejected = f.requests[0]!
  expect(readEditOutbox(f.key)).toBeUndefined()
  await settings()
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(authoring().getByTitle('Rename workflow')).toHaveTextContent('Other saved name'))
  const freshId = draft(f).context.draft.id
  expect(freshId).not.toBe(originalId)
  expect(draft(f).context.draft.baseWorkflowVersionId).toBe(f.saved().currentVersionId)
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
  await userEvent.click(recovery().getByRole('button', { name: 'View unsaved draft' }))
  expect(labelled('Read-only recovered draft')).toHaveTextContent('My first unsaved name')
  expect(labelled('Read-only recovered draft')).toHaveTextContent(originalVersion!)
  const freshBase = { revision: draft(f).context.draft.publishedRevision, version: draft(f).context.draft.baseWorkflowVersionId }
  await rename('My first unsaved name')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
  const accepted = f.requests.at(-1)!
  expect(accepted.commandId).not.toBe(rejected.commandId)
  expect(accepted).toMatchObject({ draftId: freshId, expectedRevision: freshBase.revision,
    expectedWorkflowVersionId: freshBase.version, graph: { name: 'My first unsaved name' } })
  expect(f.saved().version.definition.name).toBe('My first unsaved name')
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
}, 30000)

it('retains repeated recoveries through refresh, saves into the newest base and discards one recovery', async () => {
  const f = await recoveryFixture(), first = await mount(f)
  await rename('My first unsaved name')
  f.externalEdit('Other saved name')
  await settings()
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(authoring().getByTitle('Rename workflow')).toHaveTextContent('Other saved name'))
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
  await rename('My second unsaved name')
  f.externalEdit('Newer saved name')
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(authoring().getByTitle('Rename workflow')).toHaveTextContent('Newer saved name'))
  expect(readConflictRecoveries(f.key)).toHaveLength(2)
  const finalBase = { id: draft(f).context.draft.id, revision: draft(f).context.draft.publishedRevision,
    version: draft(f).context.draft.baseWorkflowVersionId }
  first.unmount()
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  await mount(f); await settings()
  expect(recovery().getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2)
  expect(draft(f).context.draft.id).toBe(finalBase.id)
  await rename('My first unsaved name')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
  expect(f.requests.at(-1)).toMatchObject({ draftId: finalBase.id, expectedRevision: finalBase.revision,
    expectedWorkflowVersionId: finalBase.version, graph: { name: 'My first unsaved name' } })
  expect(f.saved().version.definition.name).toBe('My first unsaved name')
  expect(readConflictRecoveries(f.key)).toHaveLength(2)
  await userEvent.click(recovery().getAllByRole('button', { name: 'Discard recovered draft' })[0]!)
  await userEvent.click(within(await findDialog('Discard this recovered draft?', 'alertdialog'))
    .getByRole('button', { name: 'Discard recovered draft' }))
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
  expect(f.wire.writes().every(sample => sample.path.endsWith('/definition/edits'))).toBe(true)
}, 30000)

it.each(['write', 'read', 'latest-response'] as const)('keeps the original editor and transport base when %s recovery fails', async failure => {
  const f = await recoveryFixture(); await mount(f)
  await rename('Keep this active form'); await settings()
  const original = draft(f), beforeReads = f.wire.samples.length
  f.externalEdit('Another saved base')
  const restore = failure === 'write' ? vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError') })
    : failure === 'read' ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key.includes('recovery')) throw new DOMException('Recovery read denied', 'SecurityError')
      return getItem.call(this, key)
    }) : undefined
  if (failure === 'latest-response') f.controls.failLatestRead = true
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  if (failure === 'read') {
    expect(await screen.findByRole('alert')).toHaveTextContent('Recovery read denied')
  }
  const errorText = failure === 'latest-response' ? 'Latest saved workflow could not be read.'
    : failure === 'read' ? 'Recovery read denied' : /Durable edit storage is unavailable/
  await screen.findAllByText(errorText)
  restore?.mockRestore(); f.controls.failLatestRead = false
  expect(draft(f).instanceId).toBe(original.instanceId)
  expect(draft(f).graph).toEqual(original.graph)
  expect(draft(f).context.draft).toEqual(original.context.draft)
  if (failure !== 'latest-response') expect(f.wire.samples.slice(beforeReads).filter(sample => sample.path === f.path)).toHaveLength(0)
  await rename('Keep this active form after retry')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  expect(f.requests.at(-1)).toMatchObject({ draftId: original.context.draft.id,
    expectedRevision: original.context.draft.publishedRevision, expectedWorkflowVersionId: original.context.draft.baseWorkflowVersionId })
}, 30000)
const getItem = Storage.prototype.getItem

it('blocks Inspect latest while Stage is uncertain and reconciles the original immutable command before opening a fresh base', async () => {
  const f = await recoveryFixture()
  const view = await mount(f)
  await rename('Exact pending name'); await settings()
  f.controls.loseStageReply = true
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(readEditOutbox(f.key)).toBeDefined())
  const original = structuredClone(readEditOutbox(f.key)!.request)
  expect(recovery().getByRole('button', { name: 'Inspect latest' })).toBeDisabled()
  expect(readConflictRecoveries(f.key)).toEqual([])
  await waitFor(() => expect(f.requests).toHaveLength(1))
  await waitFor(() => expect(view.cache.isMutating()).toBe(0))
  await waitFor(() => expect(toolbar('Draft actions').getByRole('button', { name: 'Reconcile Save' })).toBeEnabled())
  expect(queryDialog('Remove workflow node')).not.toBeInTheDocument()
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Reconcile Save' }))
  expect(queryDialog('Save changes before leaving?', 'alertdialog')).not.toBeInTheDocument()
  await waitFor(() => expect(readEditOutbox(f.key)).toBeUndefined())
  expect(f.requests.length).toBeGreaterThan(1)
  for (const input of f.requests) expect(input).toEqual(original)
  expect(f.saved().version.definition.name).toBe('Exact pending name')
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(draft(f).context.draft.id).not.toBe(original.draftId))
  expect(readConflictRecoveries(f.key)).toHaveLength(1)
}, 30000)
