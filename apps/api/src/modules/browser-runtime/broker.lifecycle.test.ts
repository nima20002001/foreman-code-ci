import { expect, it, vi } from 'vitest'
import { BrowserControlSchema } from '@foreman-code/contracts/browser-sessions'
import { DomainError } from '../errors.js'
import { BrowserBroker } from './broker.js'
import type { AgentSubject, BrowserActor, BrowserNativeDriver, BrowserPreparedBinding,
  BrowserPrepareResult, BrowserRuntimeJournal, BrowserRuntimeReceipt, BrowserRuntimeSessionRecord,
  BrowserSession, BrowserSubjectAuthority, NativeBrowserTab, NodeBrowserSettings } from './types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function execution(node = 'node', attempt = 1): AgentSubject {
  return { kind: 'execution', agent: { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: node,
    agentId: 'reusable-agent', productRole: 'coder', displayName: 'Builder', configurationVersionId: 'configuration' },
  execution: { runId: 'run', workflowVersionId: 'workflow-version', executionId: `${node}-execution`, attempt } }
}

function memoryJournal(): BrowserRuntimeJournal {
  const commands = new Map<string, BrowserRuntimeReceipt>(), sessions = new Map<string, BrowserRuntimeSessionRecord>()
  return {
    read: async key => { const value = commands.get(key); return value ? structuredClone(value) : undefined },
    write: async (key, receipt) => { commands.set(key, structuredClone(receipt)) },
    saveSession: async value => { sessions.set(value.session.id, structuredClone(value)) },
    loadSessions: async () => [...sessions.values()].map(value => structuredClone(value)),
  }
}

function nativeFixture() {
  let nextTarget = 0
  const profiles = new Map<string, number>()
  const tabs = new Map<string, NativeBrowserTab & { profileId: string; generation: number }>()
  const driver: BrowserNativeDriver = {
    closeProfile: vi.fn(async profileId => { profiles.delete(profileId) }),
    settlePopups: vi.fn(async () => undefined),
    openProfile: vi.fn(async profileId => {
      const generation = profiles.get(profileId) ?? 1; profiles.set(profileId, generation); return { generation }
    }),
    reconnectProfile: vi.fn(async profileId => profiles.has(profileId) ? { generation: profiles.get(profileId)! } : null),
    restoreTab: vi.fn(async (profileId, generation, targetId) => {
      const tab = tabs.get(targetId)
      return tab && tab.profileId === profileId && tab.generation === generation ? tab : null
    }),
    createTab: vi.fn(async (profileId, generation) => {
      const tab = { targetId: `native-target-${++nextTarget}`, title: 'Fixture page', url: 'about:blank', profileId, generation }
      tabs.set(tab.targetId, tab); return tab
    }),
    closeTab: vi.fn(async (profileId, generation, targetId) => {
      const tab = tabs.get(targetId)
      if (tab && (tab.profileId !== profileId || tab.generation !== generation)) throw new Error('Foreign native target')
      tabs.delete(targetId)
    }),
    dispatch: vi.fn(async (profileId, generation, targetId, method, params) => {
      const tab = tabs.get(targetId)
      if (!tab || tab.profileId !== profileId || tab.generation !== generation) throw new Error('Foreign native dispatch')
      return { method, params }
    }),
    action: vi.fn(async (action, dispatch) => dispatch('Fixture.action', { action })),
    observe: vi.fn(async dispatch => {
      await dispatch('Fixture.observe')
      return { title: 'Observed fixture', url: 'https://fixture.test/', text: 'Fixture content', dialog: null }
    }),
    input: vi.fn(async (input, dispatch) => { await dispatch('Fixture.input', { input }) }),
    releasePressed: vi.fn(async dispatch => { await dispatch('Fixture.releasePressed') }),
    capture: vi.fn(async () => async () => undefined), openLocal: vi.fn(async () => undefined),
    facts: vi.fn(() => ({ dialog: null, uploadChooser: null })),
    onTabClosed: vi.fn(() => () => undefined), onPopup: vi.fn(() => () => undefined),
  }
  return { driver }
}

function fixture() {
  const { driver } = nativeFixture(), journal = memoryJournal()
  const assignments = new Map<string, BrowserPreparedBinding>(), ended = new Set<string>()
  const subjectKey = (subject: AgentSubject) => JSON.stringify(subject)
  const authority: BrowserSubjectAuthority = {
    resolve: vi.fn(async subject => {
      const binding = assignments.get(subjectKey(subject))
      if (!binding) throw new DomainError('BROWSER_SCOPE_MISMATCH', 'Unknown exact subject.', 403)
      return structuredClone(binding)
    }),
    assertCurrent: vi.fn(async (subject, assignment?: { profileId: string }) => {
      if (ended.has(subjectKey(subject))) throw new DomainError('AGENT_SUBJECT_ENDED', 'The exact subject has ended.', 403)
      if (assignment && assignments.get(subjectKey(subject))?.browser.profileId !== assignment.profileId) {
        throw new DomainError('BROWSER_SCOPE_MISMATCH', 'The browser profile assignment changed.', 409)
      }
    }),
  }
  const broker = new BrowserBroker({ computerId: 'main', driver, journal, authority })
  const request = (subject: AgentSubject = execution(), commandId = 'prepare', profileId = 'profile') => {
    const browser: NodeBrowserSettings = { enabled: true, profileId }
    assignments.set(subjectKey(subject), { subject, browser, computerId: 'main', readOnly: false, availability: 'ready' })
    return { subject, browser, computerId: 'main', commandId }
  }
  return { driver, journal, authority, broker, request,
    end: (subject: AgentSubject) => { ended.add(subjectKey(subject)) },
    assignment: (subject: AgentSubject, browser: NodeBrowserSettings, availability: BrowserPreparedBinding['availability'] = 'ready') => {
      assignments.set(subjectKey(subject), { subject, browser, computerId: 'main', readOnly: false, availability })
    } }
}

function ready(result: BrowserPrepareResult) {
  if (result.kind !== 'ready') throw new Error(`Expected an owned browser, received ${result.reason}`)
  return result
}

it('retains a valid explained control state after setup closure and journal recovery', async () => {
  const f = fixture()
  const session = await f.broker.openSetup('profile', 'setup')
  expect(await f.broker.closeSetup(session.id)).toMatchObject({ state: 'closed' })
  const control = BrowserControlSchema.parse(f.broker.read(session.id).control)
  expect(control).toMatchObject({ state: 'paused', controllingViewerId: null, reason: expect.any(String) })
  const recovered = new BrowserBroker({ computerId: 'main', driver: f.driver, journal: f.journal, authority: f.authority })
  await recovered.recover()
  expect(recovered.read(session.id)).toMatchObject({ session: { state: 'closed' }, control })
  expect(await recovered.closeSetup(session.id)).toMatchObject({ state: 'already_closed' })
})

function agent(session: BrowserSession, epoch = 0): BrowserActor {
  return { kind: 'agent', epoch, browserGeneration: session.browserGeneration }
}

it('isolates exact node, attempt, conversation, setup and profile leases even when native profiles are shared', async () => {
  const f = fixture(), a = execution(), anotherNode = execution('other-node'), nextAttempt = execution('node', 2)
  const conversation: AgentSubject = { kind: 'conversation', agent: a.agent, conversationId: 'conversation' }
  const subjects = [a, anotherNode, nextAttempt, conversation]
  const sessions: BrowserSession[] = []
  for (const [index, subject] of subjects.entries()) sessions.push(ready(await f.broker.prepare(f.request(subject, `prepare-${index}`))).session)
  const otherProfile = ready(await f.broker.prepare(f.request(execution('separate-profile'), 'prepare-other', 'other-profile'))).session
  const setup = await f.broker.openSetup('profile', 'setup')
  const all = [...sessions, otherProfile, setup]
  expect(new Set(all.map(value => value.id)).size).toBe(all.length)
  expect(new Set(all.map(value => value.selectedTabId)).size).toBe(all.length)
  for (const [index, subject] of subjects.entries()) expect(f.broker.list(subject).map(value => value.id)).toEqual([sessions[index]!.id])
  const first = sessions[0]!, second = sessions[1]!, dispatched = vi.mocked(f.driver.dispatch).mock.calls.length
  await expect(f.broker.action({ sessionId: first.id, tabId: second.selectedTabId!, actor: agent(first),
    commandId: 'borrowed-tab', action: { kind: 'click', x: 10, y: 20 } })).rejects.toMatchObject({ code: 'BROWSER_TAB_SCOPE' })
  await expect(f.broker.release({ sessionId: first.id, subject: anotherNode, commandId: 'foreign-release', reason: 'terminal' }))
    .rejects.toMatchObject({ code: 'BROWSER_SCOPE_MISMATCH' })
  expect(vi.mocked(f.driver.dispatch).mock.calls.length).toBe(dispatched)
  expect(await f.broker.release({ sessionId: first.id, subject: a, commandId: 'release', reason: 'terminal' })).toMatchObject({ state: 'closed' })
  expect(f.broker.read(second.id).session.state).toBe('ready')
  expect(f.broker.read(setup.id).session.state).toBe('ready')
  expect(await f.broker.action({ sessionId: second.id, tabId: second.selectedTabId!, actor: agent(second),
    commandId: 'other-still-usable', action: { kind: 'click', x: 5, y: 6 } })).toMatchObject({ state: 'completed' })
})

it('replays the exact action receipt and rejects reusing its command ID with changed action or actor input', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const input = { sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session), commandId: 'navigate',
    action: { kind: 'navigate' as const, url: 'https://fixture.test/one' } }
  const receipt = await f.broker.action(input)
  expect(await f.broker.action(input)).toEqual(receipt)
  await expect(f.broker.action({ ...input, action: { ...input.action, url: 'https://fixture.test/two' } }))
    .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  await expect(f.broker.action({ ...input, actor: { ...input.actor, epoch: 1 } }))
    .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  expect(f.driver.action).toHaveBeenCalledTimes(1)
})

it('binds a preparation command to its original saved assignment and does not reopen a closed preparation on retry', async () => {
  const f = fixture(), input = f.request(), { session } = ready(await f.broker.prepare(input))
  expect(ready(await f.broker.prepare(input)).session.id).toBe(session.id)
  const updatedBrowser: NodeBrowserSettings = { enabled: true, profileId: 'new-profile' }
  f.assignment(input.subject, updatedBrowser)
  await expect(f.broker.prepare({ ...input, browser: updatedBrowser })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  f.assignment(input.subject, input.browser)
  await f.broker.release({ sessionId: session.id, subject: input.subject, commandId: 'terminal', reason: 'terminal' })
  expect(await f.broker.prepare(input)).toMatchObject({ kind: 'unavailable', retryable: false })
  const recovered = new BrowserBroker({ computerId: 'main', driver: f.driver, journal: f.journal, authority: f.authority })
  await recovered.recover()
  expect(await recovered.prepare(input)).toMatchObject({ kind: 'unavailable', retryable: false })
  expect(f.driver.createTab).toHaveBeenCalledTimes(1)
  expect(f.driver.openProfile).toHaveBeenCalledTimes(1)
})

it.each(['profile', 'disabled'] as const)('retires a conversation browser when its accepted assignment becomes %s', async change => {
  const f = fixture()
  const subject: AgentSubject = { kind: 'conversation', agent: execution().agent, conversationId: 'conversation' }
  const first = ready(await f.broker.prepare(f.request(subject, 'first-conversation-turn'))).session
  const peer = ready(await f.broker.prepare(f.request(execution('peer'), 'peer-turn'))).session
  const browser: NodeBrowserSettings = change === 'profile' ? { enabled: true, profileId: 'second-profile' } : { enabled: false }
  f.assignment(subject, browser)
  const prepared = await f.broker.prepare({ subject, browser, computerId: 'main', commandId: 'later-conversation-turn' })
  expect(f.broker.read(first.id).session.state).toBe('closed')
  expect(f.broker.read(peer.id).session.state).toBe('ready')
  if (change === 'profile') {
    const second = ready(prepared).session
    expect(second.id).not.toBe(first.id)
    expect(second.profileId).toBe('second-profile')
  } else expect(prepared).toEqual({ kind: 'unavailable', reason: 'disabled', retryable: false })
})

it('keeps a changed conversation assignment pending until its previous native leases close', async () => {
  const f = fixture()
  const subject: AgentSubject = { kind: 'conversation', agent: execution().agent, conversationId: 'conversation' }
  const first = ready(await f.broker.prepare(f.request(subject, 'first-conversation-turn'))).session
  vi.mocked(f.driver.closeTab).mockRejectedValueOnce(new Error('The old tab has not closed'))
  const browser = { enabled: true, profileId: 'second-profile' }
  f.assignment(subject, browser)
  const input = { subject, browser, computerId: 'main', commandId: 'later-conversation-turn' }
  expect(await f.broker.prepare(input)).toMatchObject({ kind: 'unavailable', reason: 'profile_busy', retryable: true })
  expect(f.driver.createTab).toHaveBeenCalledTimes(1)
  const second = ready(await f.broker.prepare(input)).session
  expect(f.broker.read(first.id).session.state).toBe('closed')
  expect(second.profileId).toBe('second-profile')
})

it.each(['profile_missing', 'runtime_missing'] as const)(
  'retires an obsolete conversation browser before waiting for replacement %s', async availability => {
    const f = fixture()
    const subject: AgentSubject = { kind: 'conversation', agent: execution().agent, conversationId: 'conversation' }
    const first = ready(await f.broker.prepare(f.request(subject, 'first-turn'))).session
    const peer = ready(await f.broker.prepare(f.request(execution('peer'), 'peer-turn'))).session
    const browser = { enabled: true, profileId: 'replacement-profile' }
    f.assignment(subject, browser, availability)
    const result = await f.broker.prepare({ subject, browser, computerId: 'main', commandId: 'replacement-turn' })
    expect(result).toEqual({ kind: 'unavailable', reason: availability, retryable: true })
    expect(f.broker.read(first.id)).toMatchObject({ session: { state: 'closed', selectedTabId: null }, tabs: [] })
    expect(f.broker.read(first.id).control.epoch).toBeGreaterThan(0)
    expect(f.broker.read(peer.id).session.state).toBe('ready')
    expect(f.driver.openProfile).not.toHaveBeenCalledWith('replacement-profile')
    expect(await f.broker.action({ sessionId: peer.id, tabId: peer.selectedTabId!, actor: agent(peer),
      commandId: 'peer-still-usable', action: { kind: 'click', x: 1, y: 2 } })).toMatchObject({ state: 'completed' })
  },
)

it('rejects obsolete conversation dispatch before replacement preparation runs', async () => {
  const f = fixture()
  const subject: AgentSubject = { kind: 'conversation', agent: execution().agent, conversationId: 'conversation' }
  const first = ready(await f.broker.prepare(f.request(subject, 'first-turn'))).session
  const dispatch = f.broker.checkedDispatch(first.id, first.selectedTabId!, agent(first))
  f.assignment(subject, { enabled: true, profileId: 'missing-profile' }, 'profile_missing')
  await expect(dispatch('Fixture.obsolete-profile')).rejects.toMatchObject({ code: 'BROWSER_SCOPE_MISMATCH' })
  await expect(f.broker.action({ sessionId: first.id, tabId: first.selectedTabId!, actor: agent(first),
    commandId: 'obsolete-action', action: { kind: 'click', x: 1, y: 2 } }))
    .rejects.toMatchObject({ code: 'BROWSER_SCOPE_MISMATCH' })
  expect(f.driver.dispatch).not.toHaveBeenCalled()
})

it('keeps an unavailable replacement fenced while obsolete native tab cleanup retries', async () => {
  const f = fixture()
  const subject: AgentSubject = { kind: 'conversation', agent: execution().agent, conversationId: 'conversation' }
  const first = ready(await f.broker.prepare(f.request(subject, 'first-turn'))).session
  const dispatch = f.broker.checkedDispatch(first.id, first.selectedTabId!, agent(first))
  const browser = { enabled: true, profileId: 'missing-profile' }
  f.assignment(subject, browser, 'profile_missing')
  vi.mocked(f.driver.closeTab).mockRejectedValueOnce(new Error('Native tab closure is not confirmed'))
  const input = { subject, browser, computerId: 'main', commandId: 'replacement-turn' }
  expect(await f.broker.prepare(input)).toEqual({ kind: 'unavailable', reason: 'profile_busy', retryable: true })
  expect(f.broker.read(first.id).control).toMatchObject({ state: 'paused', epoch: 1 })
  await expect(dispatch('Fixture.blocked-during-cleanup')).rejects.toMatchObject({ code: 'BROWSER_SCOPE_MISMATCH' })
  expect(await f.broker.prepare(input)).toEqual({ kind: 'unavailable', reason: 'profile_missing', retryable: true })
  expect(f.broker.read(first.id).session.state).toBe('closed')
  expect(f.driver.createTab).toHaveBeenCalledTimes(1)
  f.assignment(subject, browser)
  expect(ready(await f.broker.prepare(input)).session.profileId).toBe('missing-profile')
  expect(f.driver.createTab).toHaveBeenCalledTimes(2)
})

it('waits for the old conversation profile process after its tabs have closed', async () => {
  const f = fixture()
  const subject: AgentSubject = { kind: 'conversation', agent: execution().agent, conversationId: 'conversation' }
  const first = ready(await f.broker.prepare(f.request(subject, 'first-conversation-turn'))).session
  vi.mocked(f.driver.closeProfile).mockRejectedValueOnce(new Error('The profile process has not closed'))
  const browser = { enabled: true, profileId: 'second-profile' }
  f.assignment(subject, browser)
  const input = { subject, browser, computerId: 'main', commandId: 'later-conversation-turn' }
  expect(await f.broker.prepare(input)).toMatchObject({ kind: 'unavailable', reason: 'profile_busy', retryable: true })
  expect(f.driver.createTab).toHaveBeenCalledTimes(1)
  const second = ready(await f.broker.prepare(input)).session
  expect(f.broker.read(first.id).session.state).toBe('closed')
  expect(second.profileId).toBe('second-profile')
})

it('acknowledges takeover only after releasing pressed state and fences a delayed helper follow-up', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const entered = deferred<void>(), proceed = deferred<void>()
  vi.mocked(f.driver.action).mockImplementationOnce(async (_action, dispatch) => {
    await dispatch('Fixture.first')
    entered.resolve(); await proceed.promise
    return dispatch('Fixture.late-follow-up')
  })
  const action = f.broker.action({ sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session),
    commandId: 'helper', action: { kind: 'click', x: 2, y: 3 } })
  const rejection = expect(action).rejects.toMatchObject({ code: 'BROWSER_PAUSED' })
  await entered.promise
  const control = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'viewer', commandId: 'take' })
  expect(control).toMatchObject({ state: 'user', controllingViewerId: 'viewer' })
  expect(f.driver.releasePressed).toHaveBeenCalledTimes(1)
  proceed.resolve(); await rejection
  expect(vi.mocked(f.driver.dispatch).mock.calls.map(call => call[3])).toEqual(['Fixture.first', 'Fixture.releasePressed'])
})

it('ignores a stale release without fencing the current agent or changing its control epoch', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const held = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration, viewerId: 'viewer', commandId: 'take' })
  const returned = await f.broker.releaseControl({ sessionId: session.id, viewerId: 'viewer', epoch: held.epoch, commandId: 'return' })
  expect(returned.state).toBe('agent')
  await expect(f.broker.releaseControl({ sessionId: session.id, viewerId: 'viewer', epoch: held.epoch, commandId: 'stale-return' }))
    .rejects.toMatchObject({ code: 'BROWSER_STALE_INPUT' })
  expect(f.broker.read(session.id).control).toEqual(returned)
  expect(await f.broker.action({ sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session, returned.epoch),
    commandId: 'current-agent', action: { kind: 'type', text: 'still admitted' } })).toMatchObject({ state: 'completed' })
})

it('retains an unknown action receipt after control and tab changes without dispatching that action twice', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  vi.mocked(f.driver.action).mockImplementationOnce(async (_action, dispatch) => {
    await dispatch('Fixture.native-effect')
    throw new Error('reply lost after native effect')
  })
  const input = { sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session), commandId: 'unknown',
    action: { kind: 'type' as const, text: 'one effect' } }
  await expect(f.broker.action(input)).rejects.toThrow('reply lost after native effect')
  const held = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration, viewerId: 'viewer', commandId: 'take' })
  const returned = await f.broker.releaseControl({ sessionId: session.id, viewerId: 'viewer', epoch: held.epoch, commandId: 'return' })
  const current = agent(session, returned.epoch)
  const created = await f.broker.createTab({ sessionId: session.id, actor: current, commandId: 'new-tab' })
  await f.broker.closeTab({ sessionId: session.id, tabId: input.tabId, actor: current, commandId: 'close-old-tab' })
  await expect(f.broker.action(input)).rejects.toMatchObject({ code: 'BROWSER_RESULT_UNKNOWN' })
  await expect(f.broker.action({ ...input, actor: current, tabId: created.createdTabId })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  expect(f.driver.action).toHaveBeenCalledTimes(1)
  expect(vi.mocked(f.driver.dispatch).mock.calls.filter(call => call[3] === 'Fixture.native-effect')).toHaveLength(1)
})

it('returns a completed action receipt after its old tab closes without applying the action again', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const input = { sessionId: session.id, tabId: session.selectedTabId!, actor: agent(session), commandId: 'completed',
    action: { kind: 'click' as const, x: 20, y: 30 } }
  const receipt = await f.broker.action(input)
  await f.broker.createTab({ sessionId: session.id, actor: input.actor, commandId: 'new-tab' })
  await f.broker.closeTab({ sessionId: session.id, tabId: input.tabId, actor: input.actor, commandId: 'close-old-tab' })
  expect(await f.broker.action(input)).toEqual(receipt)
  expect(f.driver.action).toHaveBeenCalledTimes(1)
})

it('rechecks terminal subject authority after a delayed profile allocation before creating its first tab', async () => {
  const f = fixture(), input = f.request(), entered = deferred<void>(), proceed = deferred<void>()
  const open = vi.mocked(f.driver.openProfile).getMockImplementation()!
  vi.mocked(f.driver.openProfile).mockImplementationOnce(async profileId => {
    const profile = await open(profileId); entered.resolve(); await proceed.promise; return profile
  })
  const opening = f.broker.prepare(input), rejection = expect(opening).rejects.toMatchObject({ code: 'AGENT_SUBJECT_ENDED' })
  await entered.promise; f.end(input.subject); proceed.resolve(); await rejection
  expect(f.driver.createTab).not.toHaveBeenCalled()
  expect(f.broker.list(input.subject)).toEqual([])
  expect(f.broker.activeSessionCount()).toBe(0)
})

it('compensates an already allocated tab when its exact subject ends before preparation can complete', async () => {
  const f = fixture(), input = f.request(), entered = deferred<void>(), proceed = deferred<void>()
  const create = vi.mocked(f.driver.createTab).getMockImplementation()!
  vi.mocked(f.driver.createTab).mockImplementationOnce(async (profileId, generation, token) => {
    const tab = await create(profileId, generation, token); entered.resolve(); await proceed.promise; return tab
  })
  const opening = f.broker.prepare(input), rejection = expect(opening).rejects.toMatchObject({ code: 'AGENT_SUBJECT_ENDED' })
  await entered.promise; f.end(input.subject); proceed.resolve(); await rejection
  expect(f.driver.closeTab).toHaveBeenCalledTimes(1)
  expect(f.broker.list(input.subject)).toEqual([expect.objectContaining({ state: 'closed', selectedTabId: null })])
  expect(f.broker.activeSessionCount()).toBe(0)
})

it('healthy reconnect preserves another controlling viewer and never steals or invalidates its current epoch', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const held = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'first-viewer', commandId: 'take-first' })
  const read = await f.broker.reconnect({ sessionId: session.id, commandId: 'other-viewer-reconnect' })
  expect(read.control).toEqual(held)
  expect(f.driver.reconnectProfile).not.toHaveBeenCalled()
  const denied = { sessionId: session.id, browserGeneration: session.browserGeneration, viewerId: 'second-viewer', commandId: 'busy-take' }
  await expect(f.broker.acquire(denied)).rejects.toMatchObject({ code: 'BROWSER_CONTROL_BUSY' })
  expect(f.broker.read(session.id).control).toEqual(held)
  await f.broker.releaseControl({ sessionId: session.id, viewerId: 'first-viewer', epoch: held.epoch, commandId: 'return' })
  await expect(f.broker.acquire(denied)).rejects.toMatchObject({ code: 'BROWSER_CONTROL_BUSY' })
  expect(await f.broker.acquire({ ...denied, commandId: 'fresh-take' })).toMatchObject({ state: 'user', controllingViewerId: 'second-viewer' })
})

it('reclaims disconnected viewer ownership after reload without resuming the agent or accepting stale input', async () => {
  const f = fixture(), { session } = ready(await f.broker.prepare(f.request()))
  const held = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'old-viewer', commandId: 'take' })
  await f.broker.disconnectViewer(session.id, 'old-viewer')
  const paused = f.broker.read(session.id).control
  expect(paused.state).toBe('paused')
  const dispatch = f.broker.checkedDispatch(session.id, session.selectedTabId!, agent(session, paused.epoch))
  await expect(dispatch('Fixture.blocked')).rejects.toMatchObject({ code: 'BROWSER_PAUSED' })
  const reclaimed = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'reloaded-viewer', commandId: 'reclaim' })
  expect(reclaimed).toMatchObject({ state: 'user', controllingViewerId: 'reloaded-viewer' })
  expect(reclaimed.epoch).toBeGreaterThan(held.epoch)
  await expect(f.broker.action({ sessionId: session.id, tabId: session.selectedTabId!, commandId: 'stale-input',
    actor: { kind: 'viewer', viewerId: 'old-viewer', browserGeneration: session.browserGeneration, epoch: held.epoch },
    action: { kind: 'type', text: 'stale' } })).rejects.toMatchObject({ code: 'BROWSER_STALE_INPUT' })
  await f.broker.disconnectViewer(session.id, 'old-viewer')
  expect(f.broker.read(session.id).control).toEqual(reclaimed)
  const resumed = await f.broker.releaseControl({ sessionId: session.id, viewerId: 'reloaded-viewer',
    epoch: reclaimed.epoch, commandId: 'resume' })
  expect(await f.broker.action({ sessionId: session.id, tabId: session.selectedTabId!, commandId: 'agent-resumed',
    actor: agent(session, resumed.epoch), action: { kind: 'type', text: 'resumed' } })).toMatchObject({ state: 'completed' })
})

it('closes an idle profile process only after its final session releases it', async () => {
  const f = fixture(), first = execution('first'), second = execution('second')
  const a = ready(await f.broker.prepare(f.request(first, 'first'))).session
  const b = ready(await f.broker.prepare(f.request(second, 'second'))).session
  await f.broker.release({ sessionId: a.id, subject: first, commandId: 'close-first', reason: 'terminal' })
  expect(f.driver.closeProfile).not.toHaveBeenCalled()
  await f.broker.release({ sessionId: b.id, subject: second, commandId: 'close-second', reason: 'terminal' })
  expect(f.driver.closeProfile).toHaveBeenCalledExactlyOnceWith('profile')
  expect(await f.driver.reconnectProfile('profile')).toBeNull()
})

it('closes a verified popup attached while its owner is closing without touching a sibling session', async () => {
  const f = fixture(), subject = execution()
  const session = ready(await f.broker.prepare(f.request(subject))).session
  const sibling = ready(await f.broker.prepare(f.request(execution('sibling'), 'sibling'))).session
  const opener = vi.mocked(f.driver.createTab).mock.results[0]!
  const openerTab = await opener.value
  const entered = deferred<void>(), finish = deferred<void>()
  const close = vi.mocked(f.driver.closeTab).getMockImplementation()!
  vi.mocked(f.driver.closeTab).mockImplementationOnce(async (...args) => {
    entered.resolve(); await finish.promise; await close(...args)
  })
  const closing = f.broker.release({ sessionId: session.id, subject, commandId: 'close', reason: 'terminal' })
  await entered.promise
  const popup = await f.driver.createTab('profile', session.browserGeneration)
  const receive = vi.mocked(f.driver.onPopup).mock.calls[0]![0]
  await receive('profile', session.browserGeneration, openerTab.targetId, popup)
  finish.resolve()
  expect(await closing).toMatchObject({ state: 'closed' })
  expect(await f.driver.restoreTab('profile', session.browserGeneration, popup.targetId)).toBeNull()
  expect(await f.broker.action({ sessionId: sibling.id, tabId: sibling.selectedTabId!, actor: agent(sibling),
    commandId: 'sibling-alive', action: { kind: 'click', x: 2, y: 3 } })).toMatchObject({ state: 'completed' })
})

it('retains the native-window controller so it can explicitly release paused control', async () => {
  const f = fixture(), session = await f.broker.openSetup('profile', 'setup')
  const control = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'viewer', commandId: 'take' })
  const paused = await f.broker.openLocal({ sessionId: session.id, tabId: session.selectedTabId!, commandId: 'local',
    actor: { kind: 'viewer', viewerId: 'viewer', epoch: control.epoch, browserGeneration: session.browserGeneration } })
  expect(paused).toMatchObject({ state: 'paused', controllingViewerId: 'viewer' })
  expect(await f.broker.releaseControl({ sessionId: session.id, viewerId: 'viewer', epoch: paused.epoch,
    commandId: 'return' })).toMatchObject({ controllingViewerId: null })
})

it('allows a newly authenticated viewer to reclaim ownership after host journal recovery', async () => {
  const f = fixture(), session = await f.broker.openSetup('profile', 'setup')
  await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'previous-viewer', commandId: 'take' })
  const recovered = new BrowserBroker({ computerId: 'main', driver: f.driver, journal: f.journal, authority: f.authority })
  await recovered.recover()
  expect(recovered.read(session.id).control.state).toBe('paused')
  expect(await recovered.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
    viewerId: 'fresh-viewer', commandId: 'reclaim' })).toMatchObject({ state: 'user', controllingViewerId: 'fresh-viewer' })
})
