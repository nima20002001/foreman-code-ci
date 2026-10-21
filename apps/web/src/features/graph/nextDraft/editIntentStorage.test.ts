import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { journalRequest } from './nim2644Journal.fixture'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { protectedKey, rotateProtectedSession } from '../../../shared/api/protectedChatStorage'
import { fixture } from './core.cases'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { savedClaudeConfiguration } from '../../settings/claudeSettings.fixtures'
import { createHarnessEditor, switchHarnessEditor } from '../../settings/harnessEditor'
import type { AgentForm } from './agentForm'
import { nextDraftKey, newNextDraft } from './state'
import { acknowledgeEditOutbox, clearEditIntentStorage, readEditOutbox, readEditSnapshot,
  reserveEditOutbox, storeEditSnapshot, withEditIntentLock, type EditIntentOutbox } from './editIntentStorage'

const key = nextDraftKey('workspace', 'workflow')
function candidate(commandId = 'exact-stage'): EditIntentOutbox {
  const context = fixture()
  return { request: journalRequest(newNextDraft(context, 'fixture'), commandId), target: context.draft.graph }
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); clearEditIntentStorage() })

describe('NIM-2642 protected local form and exact-command recovery', () => {
  for (const harness of ['codex'] as const) it(`retains Claude and ${harness} provider drafts with the exact source revision across reopen`, () => {
    const context = fixture(), source = context.agents[0]!
    source.agent = { ...source.agent, harness: 'claude', model: savedClaudeConfiguration.model,
      harnessConfiguration: savedClaudeConfiguration }
    const edit = newNextDraft(context, 'claude-retained-edit'), id = source.agent.id
    const claude = { ...createHarnessEditor(savedClaudeConfiguration), mcpText: '{ unfinished Claude MCP' }
    const form: AgentForm = { base: JSON.stringify({ agent: source.agent, initialPrompt: 'Source prompt' }),
      name: source.agent.name, prompt: 'Retained prompt', editor: claude }
    edit.agentForms = { [id]: form }
    storeEditSnapshot(key, edit)
    const switched = switchHarnessEditor(claude, harness, DEFAULT_HARNESS_DEFAULTS[harness])
    const alternate = { ...switched, configuration: { ...switched.configuration, model: `retained-${harness}-model` },
      shellEnvironmentText: `{ unfinished ${harness} shell`, mcpText: `{ unfinished ${harness} MCP` }
    edit.agentForms[id] = { ...form, editor: alternate }
    storeEditSnapshot(key, edit)

    // Reopen through the real serialized snapshot, with no in-memory editor reuse.
    sessionStorage.removeItem(protectedKey('ui', 'graph-edit-intent:tab'))
    const read = readEditSnapshot(key)!, retained = read.agentForms![id]!
    expect(retained).toEqual(edit.agentForms[id])
    expect(retained.editor.configuration.harness).toBe(harness)
    expect(retained.editor.drafts?.claude).toEqual(claude)
    expect(read.context).toEqual(context)
    expect(read.context.draft.publishedRevision).toBe(7)
    expect(read.context.draft.baseWorkflowVersionId).toBe('workflow-version-1')
    expect(read.context.agents[0]).toEqual(source)
    expect(read.context.agents[0]!.metadataRevision).toBe(3)
    expect(retained.base).toBe(form.base)

    const restored = switchHarnessEditor(retained.editor, 'claude')
    expect(restored.configuration).toEqual(claude.configuration)
    expect(restored.mcpText).toBe(claude.mcpText)
    expect(restored.drafts?.[harness]).toEqual({ configuration: alternate.configuration,
      shellEnvironmentText: alternate.shellEnvironmentText, mcpText: alternate.mcpText })
    storeEditSnapshot(key, { ...read, agentForms: { [id]: { ...retained, editor: restored } } })
    const reopened = readEditSnapshot(key)!
    expect(reopened.context).toEqual(context)
    const switchedAgain = switchHarnessEditor(reopened.agentForms![id]!.editor, harness)
    expect(switchedAgain.configuration).toEqual(alternate.configuration)
    expect(switchedAgain.shellEnvironmentText).toBe(alternate.shellEnvironmentText)
    expect(switchedAgain.mcpText).toBe(alternate.mcpText)
    expect(switchedAgain.drafts?.claude).toEqual(claude)
  })
  it('retains staged graph, Agent payload, revision base and independent geometry after memory loss', () => {
    const context = fixture(), edit = newNextDraft(context, 'instance')
    edit.graph = { ...edit.graph, nodes: edit.graph.nodes.map((node, i) => i ? node : { ...node,
      initialPrompt: 'Exact retained edit', position: { x: 987, y: -12 } }) }
    edit.agentEdits = { [context.agents[0]!.agent.id]: { ...context.agents[0]!.agent, name: 'Retained Agent edit' } }
    storeEditSnapshot(key, edit)
    const read = readEditSnapshot(key)!
    expect(read.graph).toEqual(edit.graph); expect(read.context).toEqual(context); expect(read.agentEdits).toEqual(edit.agentEdits)
    // A new tab/reopen can find the last form but thereafter has its own snapshot.
    sessionStorage.removeItem(protectedKey('ui', 'graph-edit-intent:tab'))
    expect(readEditSnapshot(key)).toEqual(read)
    storeEditSnapshot(key, { ...edit, graph: { ...edit.graph, nodes: edit.graph.nodes.map((node) => ({ ...node, initialPrompt: 'New tab' })) } })
    expect(nativeNode(readEditSnapshot(key)?.graph.nodes[0])?.initialPrompt).toBe('New tab')
  })
  it('reuses the SAME request after refresh, duplicate clicks and competing newer forms', async () => {
    vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => Promise<unknown>) => work() } })
    const first = candidate(), replacement = candidate('replacement')
    expect(await withEditIntentLock(key, async () => reserveEditOutbox(key, first))).toEqual(first)
    expect(readEditOutbox(key)).toEqual(first)
    replacement.target = { ...replacement.target, nodes: replacement.target.nodes.map((node) => ({ ...node, initialPrompt: 'Newer typing' })) }
    expect(await withEditIntentLock(key, async () => reserveEditOutbox(key, replacement))).toEqual(first)
    expect(() => acknowledgeEditOutbox(key, 'replacement')).toThrow('not cleared')
    expect(readEditOutbox(key)).toEqual(first)
    acknowledgeEditOutbox(key, first.request.commandId)
    expect(readEditOutbox(key)).toBeUndefined()
  })
  it('does not clear or replace corrupted and cross-scope retained commands', () => {
    const name = protectedKey('outbox', `graph-edit-intent:${key}`)
    localStorage.setItem(name, '{invalid')
    expect(() => reserveEditOutbox(key, candidate())).toThrow('not been deleted')
    expect(localStorage.getItem(name)).toBe('{invalid')
    localStorage.setItem(name, JSON.stringify({ ...candidate(), request: { ...candidate().request, workspaceId: 'other' } }))
    expect(() => readEditOutbox(key)).toThrow('different workspace')
  })
  it('fails closed before invoking HTTP work without cross-tab locks or durable storage', async () => {
    vi.stubGlobal('navigator', {})
    const effect = vi.fn(async () => undefined)
    await expect(withEditIntentLock(key, effect)).rejects.toThrow('No Stop or save was sent')
    expect(effect).not.toHaveBeenCalled()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
    expect(() => reserveEditOutbox(key, candidate())).toThrow('Durable edit storage is unavailable')
  })
  it('isolates records on identity rotation and purges only this feature on explicit session cleanup', () => {
    reserveEditOutbox(key, candidate())
    storeEditSnapshot(key, newNextDraft(fixture(), 'local'))
    localStorage.setItem('unrelated-preference', 'keep')
    clearEditIntentStorage()
    expect(readEditOutbox(key)).toBeUndefined(); expect(readEditSnapshot(key)).toBeUndefined()
    expect(localStorage.getItem('unrelated-preference')).toBe('keep')
    reserveEditOutbox(key, candidate())
    rotateProtectedSession()
    expect(readEditOutbox(key)).toBeUndefined()
  })
})

describe('edit storage under a full browser quota', () => {
  it('frees earlier sign-in data while preserving another tab’s recovery form', () => {
    storeEditSnapshot(key, newNextDraft(fixture(), 'closed-tab-form'))
    // A newer pointer does not establish whether this independently owned tab is closed.
    const ownTab = sessionStorage.getItem(protectedKey('ui', 'graph-edit-intent:tab'))!
    const closedTab = protectedKey('draft', `graph-edit-intent:${key}:closed-tab`)
    localStorage.setItem(closedTab, localStorage.getItem(protectedKey('draft', `graph-edit-intent:${key}:${ownTab}`))!)
    localStorage.removeItem(protectedKey('draft', `graph-edit-intent:${key}:${ownTab}`))
    localStorage.setItem(protectedKey('ui', `graph-edit-intent:${key}:latest`), JSON.stringify('newer-tab'))
    localStorage.setItem('graphql.chat:earlier-epoch:draft:old-form', 'x'.repeat(100))
    localStorage.setItem('unrelated-preference', 'keep')
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
      if (this.getItem('graphql.chat:earlier-epoch:draft:old-form') !== null) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      setItem.call(this, name, value)
    })

    const edit = newNextDraft(fixture(), 'current-form')
    expect(() => storeEditSnapshot(key, edit)).not.toThrow()

    expect(readEditSnapshot(key)?.graph).toEqual(edit.graph)
    expect(JSON.parse(localStorage.getItem(closedTab)!).graph).toEqual(edit.graph)
    expect(localStorage.getItem('graphql.chat:earlier-epoch:draft:old-form')).toBeNull()
    expect(localStorage.getItem('unrelated-preference')).toBe('keep')
  })

  it('compacts the latest form of another workflow that still holds the whole Agent catalog', () => {
    const otherKey = nextDraftKey('workspace', 'other-workflow'), context = fixture()
    const catalogOnly = { ...context.agents[0]!, agent: { ...context.agents[0]!.agent, id: 'catalog-only-agent' } }
    const other = { ...context, agents: [...context.agents, catalogOnly],
      draft: { ...context.draft, workflowId: 'other-workflow', graph: { ...context.draft.graph, id: 'other-workflow' } } }
    other.savedDraft = other.draft
    const otherForm = protectedKey('draft', `graph-edit-intent:${otherKey}:other-tab`)
    // Written by an older app version: the latest copy of its workflow, with the full catalog.
    localStorage.setItem(otherForm, JSON.stringify({ context: other, graph: other.draft.graph }))
    localStorage.setItem(protectedKey('ui', `graph-edit-intent:${otherKey}:latest`), JSON.stringify('other-tab'))
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name: string, value: string) {
      if (name !== otherForm && this.getItem(otherForm)?.includes('catalog-only-agent')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      setItem.call(this, name, value)
    })

    const edit = newNextDraft(fixture(), 'current-form')
    expect(() => storeEditSnapshot(key, edit)).not.toThrow()

    expect(readEditSnapshot(key)?.graph).toEqual(edit.graph)
    const kept = JSON.parse(localStorage.getItem(otherForm)!)
    expect(kept.graph).toEqual(other.draft.graph)
    expect(kept.context.agents.map((record: { agent: { id: string } }) => record.agent.id)).toEqual(context.agents.map((record) => record.agent.id))
  })
})

describe('form copies and the workspace Agent catalog', () => {
  it('keeps only the Agents the workflow refers to', () => {
    const context = fixture()
    const catalogOnly = { ...context.agents[0]!, agent: { ...context.agents[0]!.agent, id: 'catalog-only-agent' } }
    storeEditSnapshot(key, newNextDraft({ ...context, agents: [...context.agents, catalogOnly] }, 'form'))

    expect(readEditSnapshot(key)?.context.agents.map((record) => record.agent.id)).toEqual(context.agents.map((record) => record.agent.id))
  })
})
