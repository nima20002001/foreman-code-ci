import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { fixture } from './core.cases'
import { newNextDraft, nextDraftKey } from './state'
import { retainConflictRecovery, readConflictRecoveries, discardConflictRecovery,
  storeEditSnapshot, readEditSnapshot } from './editIntentStorage'
import { createHarnessEditor } from '../../settings/harnessEditor'

const scope = nextDraftKey('workspace', 'workflow')
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear() })

it('keeps each original form, staged Agent and unfinished editor separately across fresh bases and saves', () => {
  const original = newNextDraft(fixture(), 'original-editor')
  original.graph = { ...original.graph, name: 'Keep my unsaved workflow',
    executionPolicy: { ...original.graph.executionPolicy!, maxNodeExecutions: Number.NaN } }
  original.agentEdits = { 'agent-0': { ...original.context.agents[0]!.agent, name: 'Private Agent edit' } }
  original.agentForms = { 'node-0': { base: JSON.stringify({ agent: original.context.agents[0]!.agent }),
    name: 'Unapplied form', prompt: 'Exact prompt', editor: { ...createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex),
      mcpText: '{ unfinished JSON', shellEnvironmentText: '{ unfinished environment' } } }
  original.workflowForms = { hierarchy: { masterNodeId: 'node-1', parents: { 'node-0': '' } } }
  storeEditSnapshot(scope, original)
  const first = retainConflictRecovery(scope, original)
  const second = retainConflictRecovery(scope, { ...original, graph: { ...original.graph, name: 'Second conflict' } })
  expect(first.id).not.toBe(second.id)
  expect(first.originalInstanceId).toBe(original.instanceId)
  expect(first.snapshot.graph).toEqual(original.graph)
  expect(first.snapshot.agentEdits).toEqual(original.agentEdits)
  expect(first.snapshot.agentForms).toEqual(original.agentForms)
  expect(first.snapshot.workflowForms).toEqual(original.workflowForms)
  const fresh = newNextDraft(fixture(), 'fresh-editor')
  storeEditSnapshot(scope, fresh, 'successful-new-save')
  sessionStorage.clear()
  expect(readEditSnapshot(scope)?.graph).toEqual(fresh.graph)
  const kept = readConflictRecoveries(scope)
  expect(kept).toHaveLength(2)
  expect(kept.find(item => item.id === first.id)).toEqual(first)
  discardConflictRecovery(scope, second)
  expect(readConflictRecoveries(scope)).toEqual([first])
  expect(readConflictRecoveries(nextDraftKey('workspace', 'another-workflow'))).toEqual([])
})

it('fails before replacing an active form when a recovery cannot be retained and confirmed', () => {
  const original = newNextDraft(fixture(), 'original-editor')
  original.graph = { ...original.graph, name: 'Keep this exact original' }
  storeEditSnapshot(scope, original)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
  expect(() => retainConflictRecovery(scope, original)).toThrow('Durable edit storage is unavailable')
  expect(readEditSnapshot(scope)?.graph).toEqual(original.graph)
  expect(readConflictRecoveries(scope)).toEqual([])
})

it('retains the selected recovery if storage refuses its explicit discard', () => {
  const retained = retainConflictRecovery(scope, newNextDraft(fixture(), 'original-editor'))
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => undefined)
  expect(() => discardConflictRecovery(scope, retained)).toThrow('Durable edit storage is unavailable')
  expect(readConflictRecoveries(scope)).toEqual([retained])
})
