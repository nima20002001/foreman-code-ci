import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ApiError } from '../../../shared/api/client'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { createHarnessEditor } from '../../settings/harnessEditor'
import { roleEvidence } from './model'
import { fixture } from './core.cases'
import { journalIntent, journalRequest, savedJournal } from './nim2644Journal.fixture'
import { acknowledgeEditIntentSnapshot } from './useGraphEditIntent'
import { deriveDraftEditorStatus } from './draftEditorStatus'
import { changeDraftAgent, editorAgents, stageAgentEdits } from './agentEdits'
import { editNextDraft, newNextDraft, nextDraftDirty, nextDraftKey, redoNextDraft, undoNextDraft } from './state'
import { acknowledgeEditOutbox, editSnapshotAcknowledged, readEditSnapshot, readEditSubmission, rejectEditOutbox,
  reserveEditOutbox, storeEditSnapshot } from './editIntentStorage'
import { boardScope, pendingBoardAction, publishDraftDepth, recordBoardAction, useBoardUndo } from '../../workflow-board/boardUndo'

const scope = nextDraftKey('workspace', 'workflow')
const tabKey = protectedKey('ui', 'graph-edit-intent:tab')
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  useBoardUndo.setState({ actions: {}, redo: {}, changes: {}, depth: {} })
})
afterEach(() => vi.restoreAllMocks())

it('stages Agent Undo and Redo against the published configuration after saving', () => {
  const context = fixture()
  context.agents[0]!.agent.harnessConfiguration = DEFAULT_HARNESS_DEFAULTS.codex
  context.draft.sourceAgentPins = context.agents.map(({ agent, metadataRevision }) => ({
    agentId: agent.id, metadataRevision, configurationVersionId: agent.configurationVersionId!,
  }))
  const base = newNextDraft(context, 'editor')
  const agent = context.agents[0]!.agent
  const first = changeDraftAgent(base, { ...agent, name: 'First edit' }, base.graph)
  const second = changeDraftAgent(first, { ...agent, name: 'Second edit' }, first.graph)
  storeEditSnapshot(scope, second)
  const request = journalRequest(second, 'agent-save')
  reserveEditOutbox(scope, { request, target: second.graph, agentTarget: second.agentEdits })
  const saved = savedJournal(journalIntent(request, context))
  const published = acknowledgeEditIntentSnapshot(scope, second, saved)
  const statusInput = { edit: published, editIntent: { query: {}, mutation: {} }, agents: [],
    startState: { preflight: {}, startOutbox: {} }, starting: false, reloading: false, workspace: {}, redoCount: 0,
  } as unknown as Parameters<typeof deriveDraftEditorStatus>[0]
  expect(deriveDraftEditorStatus(statusInput).canUndo).toBe(true)
  const undone = undoNextDraft(published)
  const staged = stageAgentEdits(undone)
  expect(staged[0]?.agent.name).toBe('First edit')
  expect(staged[0]?.agent.configurationVersionId).toBe(saved.result!.agents![0]!.agent.configurationVersionId)
  expect(staged[0]?.baseRevision).toBe(4)
  expect(roleEvidence(undone.context, agent.id, undone.agentEdits).source).toBe('configuration')
  const redone = redoNextDraft(undone)
  expect(editorAgents(redone)[0]?.configurationVersionId).toBe(saved.result!.agents![0]!.agent.configurationVersionId)
  expect(nextDraftDirty(redone)).toBe(false)
  expect(stageAgentEdits(undoNextDraft(undone))[0]?.agent.name).toBe('Agent 0')
  expect(redone.context.draft.revision).toBe(8)
})

it('undoes a draft edit newer than a settings action after history reaches its cap', () => {
  let edit = newNextDraft(fixture(), 'editor')
  for (let index = 0; index < 50; index++) {
    edit = editNextDraft(edit, graph => ({ ...graph, name: `Edit ${index}` }))
  }
  const board = boardScope('workspace', 'workflow')
  // The editor publishes its retained history position, including evicted entries.
  const position = (value: typeof edit) => value.history.length + ('historyOffset' in value ? Number(value.historyOffset) : 0)
  publishDraftDepth(board, position(edit))
  recordBoardAction(board, { label: 'schedule', undo: async () => undefined, redo: async () => undefined })
  edit = editNextDraft(edit, graph => ({ ...graph, name: 'After schedule' }))
  expect(edit.history).toHaveLength(50)
  expect(pendingBoardAction(board, position(edit))).toBeUndefined()
  const undone = undoNextDraft(edit)
  expect(undone.graph.name).toBe('Edit 49')
  expect(pendingBoardAction(board, position(undone))?.label).toBe('schedule')
  expect(pendingBoardAction(board, position(redoNextDraft(undone)))).toBeUndefined()
})

it('hides Undo for published graph-only history until another authored edit is made', () => {
  const edit = editNextDraft(newNextDraft(fixture(), 'editor'), graph => ({ ...graph, name: 'Saved name' }))
  storeEditSnapshot(scope, edit)
  const request = journalRequest(edit, 'graph-save')
  reserveEditOutbox(scope, { request, target: edit.graph })
  const published = acknowledgeEditIntentSnapshot(scope, edit, savedJournal(journalIntent(request, edit.context)))
  const status = (value: typeof edit) => deriveDraftEditorStatus({ edit: value,
    editIntent: { query: {}, mutation: {} }, agents: [], startState: { preflight: {}, startOutbox: {} },
    starting: false, reloading: false, workspace: {}, redoCount: 0,
  } as unknown as Parameters<typeof deriveDraftEditorStatus>[0])
  expect(published.history).toHaveLength(1)
  expect(nextDraftDirty(published)).toBe(false)
  expect(status(published).canUndo).toBe(false)
  const changed = editNextDraft(published, graph => ({ ...graph, name: 'Another edit' }))
  expect(status(changed).canUndo).toBe(true)
  const undone = undoNextDraft(changed)
  expect(undone.graph.name).toBe('Saved name')
  expect(status(undone).canUndo).toBe(false)
  expect(status(undone).canRedo).toBe(true)
})

it('preserves a suspended divergent form, Agent edits and lineage when quota recovery fails', () => {
  const original = newNextDraft(fixture(), 'suspended')
  original.graph = { ...original.graph, description: 'Suspended draft' }
  original.agentEdits = { 'agent-0': { ...original.context.agents[0]!.agent, name: 'Suspended Agent' } }
  original.agentForms = { 'agent-0': { base: JSON.stringify(original.context.agents[0]!.agent), name: 'Suspended form', prompt: 'Unsaved prompt',
    editor: { ...createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex), mcpText: '{unfinished' } } }
  sessionStorage.setItem(tabKey, 'suspended-tab')
  storeEditSnapshot(scope, original, 'consumed-command')
  const retained = readEditSnapshot(scope)
  sessionStorage.setItem(tabKey, 'writer-tab')
  storeEditSnapshot(scope, { ...original, graph: { ...original.graph, description: 'Writer draft' } })
  const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota full', 'QuotaExceededError')
  })
  expect(() => storeEditSnapshot(scope, original)).toThrow('Durable edit storage')
  fail.mockRestore()
  sessionStorage.setItem(tabKey, 'suspended-tab')
  expect(readEditSnapshot(scope)).toEqual(retained)
  expect(readEditSnapshot(scope)?.agentForms?.['agent-0']?.editor.mcpText).toBe('{unfinished')
  expect(readEditSnapshot(scope)?.agentEdits?.['agent-0']?.name).toBe('Suspended Agent')
  expect(editSnapshotAcknowledged(scope, original, 'consumed-command')).toBe(true)
})

it('collects completed submission payloads while a suspended tab can still recover its own command', () => {
  let edit = newNextDraft(fixture(), 'editor')
  edit.graph = { ...edit.graph, description: 'Suspended submission' }
  sessionStorage.setItem(tabKey, 'suspended-tab')
  storeEditSnapshot(scope, edit)
  sessionStorage.setItem(tabKey, 'writer-tab')
  storeEditSnapshot(scope, edit)
  const first = journalRequest(edit, 'suspended-command')
  reserveEditOutbox(scope, { request: first, target: edit.graph })
  const suspended = { ...journalIntent(first, edit.context), state: 'discarded' as const }
  edit = acknowledgeEditIntentSnapshot(scope, edit, suspended)
  acknowledgeEditOutbox(scope, first.commandId)
  const completed = []
  const setItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    const retained = Array.from({ length: this.length }, (_, index) => this.key(index))
      .reduce((bytes, key) => bytes + (key && key !== name ? (this.getItem(key)?.length ?? 0) : 0), 0)
    if (this === localStorage && retained + value.length > 100_000) {
      throw new DOMException('Quota full', 'QuotaExceededError')
    }
    setItem.call(this, name, value)
  })
  for (let index = 0; index < 80; index++) {
    edit = editNextDraft(edit, graph => ({ ...graph, description: `Completed ${index}: ${'x'.repeat(4096)}` }))
    storeEditSnapshot(scope, edit)
    const request = journalRequest(edit, `completed-${index}`)
    reserveEditOutbox(scope, { request, target: edit.graph })
    const intent = { ...journalIntent(request, edit.context), state: 'discarded' as const }
    edit = acknowledgeEditIntentSnapshot(scope, edit, intent)
    acknowledgeEditOutbox(scope, request.commandId)
    completed.push(intent)
  }
  expect(completed.filter(intent => readEditSubmission(scope, intent))).toHaveLength(1)
  expect(readEditSubmission(scope, suspended)?.target.description).toBe('Suspended submission')
  sessionStorage.setItem(tabKey, 'suspended-tab')
  const restored = readEditSnapshot(scope)!
  const resumed = acknowledgeEditIntentSnapshot(scope, { ...newNextDraft(restored.context, 'resumed'), graph: restored.graph }, suspended)
  expect(resumed.graph.description).toBeUndefined()
  expect(readEditSubmission(scope, suspended)).toBeUndefined()
})

it('collects definitively rejected Stage payloads without changing the recoverable form', () => {
  const edit = editNextDraft(newNextDraft(fixture(), 'editor'), graph => ({ ...graph, name: 'Retained edit' }))
  storeEditSnapshot(scope, edit)
  const before = readEditSnapshot(scope)
  for (let index = 0; index < 80; index++) {
    const request = journalRequest(edit, `rejected-${index}`)
    reserveEditOutbox(scope, { request, target: edit.graph })
    expect(rejectEditOutbox(scope, request, new ApiError({ code: 'REVISION_CONFLICT', message: 'Conflict' }, 409))).toBe(true)
    expect(readEditSubmission(scope, journalIntent(request, edit.context))).toBeUndefined()
  }
  expect(readEditSnapshot(scope)).toEqual(before)
})

it('bounds identical terminal submissions shared with a suspended form', () => {
  const initial = editNextDraft(newNextDraft(fixture(), 'editor'), graph => ({ ...graph, description: 'Same edit' }))
  sessionStorage.setItem(tabKey, 'suspended-tab')
  storeEditSnapshot(scope, initial)
  const commands = []
  sessionStorage.setItem(tabKey, 'writer-tab')
  for (let index = 0; index < 80; index++) {
    storeEditSnapshot(scope, initial)
    const request = journalRequest(initial, `same-command-${index}`)
    reserveEditOutbox(scope, { request, target: initial.graph })
    const intent = { ...journalIntent(request, initial.context), state: 'discarded' as const }
    acknowledgeEditIntentSnapshot(scope, initial, intent)
    acknowledgeEditOutbox(scope, request.commandId)
    commands.push(intent)
  }
  expect(commands.filter(intent => readEditSubmission(scope, intent))).toHaveLength(1)
  sessionStorage.setItem(tabKey, 'suspended-tab')
  const retained = readEditSnapshot(scope)!
  const resumed = acknowledgeEditIntentSnapshot(scope,
    { ...newNextDraft(retained.context, 'resumed'), graph: retained.graph }, commands.at(-1)!)
  expect(resumed.graph.description).toBeUndefined()
})
