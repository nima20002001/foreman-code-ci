import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as contracts from '@foreman-code/contracts'
import * as agentChat from '@foreman-code/contracts/agent-chat'
import * as management from '@foreman-code/contracts/management'
import * as profiles from '@foreman-code/contracts/harness-registry'
import * as placements from '@foreman-code/contracts/node-placement'
import * as workflows from '@foreman-code/contracts/wave25'
import * as roots from '@foreman-code/contracts/workspace-root-policies'
import * as boundLocations from '@foreman-code/contracts/workspace-bound-location'
import { pairedWorkerApplication } from './helpers/pairedWorkerApplication.js'
import { selectedNativeHarnesses } from './helpers/selectedNativeHarnesses.js'

type Row = { harness: 'codex' | 'claude'; role: 'operator' | 'agent'; hostKind: 'main' | 'device';
  conversationId: string; workspaceId?: string; readPath?: string; sendPath: string;
  sendRequest: Record<string, unknown>; nativeProfile: string; profileCheckRequest: Record<string, unknown> }

const harnesses = selectedNativeHarnesses()
const combinations = harnesses.flatMap(harness =>
  (['operator', 'agent'] as const).flatMap(role =>
    (['main', 'device'] as const).map(hostKind => ({ harness, role, hostKind }))))
let fixture: Awaited<ReturnType<typeof pairedWorkerApplication>> | undefined
let rows: Row[] = []
const completed = new Map<string, { marker: string; compactRequest: contracts.SessionControlRequest }>()
const nativeResults: Record<string, unknown>[] = []
const settingsResults: Record<string, unknown>[] = []
const recoveredConversations = new Set<string>()

async function saveEvidence(cleanupConfirmed: boolean) {
  const directory = process.env.ENG03_A_EVIDENCE_DIR
  if (!directory) throw new Error('The native acceptance evidence directory is missing.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `session-controls-${randomUUID()}.json`)
  await writeFile(path, JSON.stringify({ sourceCommit: fixture?.sourceCommit,
    harnesses, expectedConversations: combinations.length,
    nativeControlChecksCompleted: cleanupConfirmed && completed.size === combinations.length
      && settingsResults.length === (harnesses.includes('claude') ? 4 : 0)
      && recoveredConversations.size === combinations.length,
    unsettledDispatchRecovery: false, browserAcceptance: false, hcAcceptanceComplete: false,
    cleanupConfirmed, nativeResults, settingsResults, recoveredConversations: [...recoveredConversations],
  }, null, 2), { flag: 'wx', mode: 0o600 })
  console.info(`Native session controls evidence: ${path}`)
}

function active() {
  if (!fixture) throw new Error('The production fixture has not started.')
  return fixture
}

async function controls(row: Row) {
  const f = active()
  const value = row.role === 'operator'
    ? await f.tool('operator_chat_controls_get', { conversationId: row.conversationId })
    : await f.request(`/api/workspaces/${row.workspaceId}/agent-chat/conversations/${row.conversationId}/session-controls`)
  return contracts.SessionControlStateSchema.parse(value)
}

async function change(row: Row, input: contracts.SessionControlRequest) {
  const f = active()
  const value = row.role === 'operator'
    ? await f.tool('operator_chat_controls_update', { conversationId: row.conversationId, request: input })
    : await f.request(`/api/workspaces/${row.workspaceId}/agent-chat/conversations/${row.conversationId}/session-controls`, input)
  return contracts.SessionControlStateSchema.parse(value)
}

async function idle(row: Row) {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const state = await controls(row)
    if (!state.busyReason) return state
    await delay(50)
  }
  throw new Error('Timed out waiting for the real native conversation to become idle.')
}

async function send(row: Row, content: string, mode: 'regular' | 'plan' = 'regular') {
  const f = active()
  const input = { ...row.sendRequest, requestId: randomUUID(), content, sessionMode: mode }
  if (row.role === 'operator') await f.tool('operator_chat_send', { conversationId: row.conversationId, request: input })
  else await f.request(row.sendPath, input)
  return { input, state: await idle(row) }
}

async function conversation(row: Row) {
  const f = active()
  if (row.role === 'operator') {
    return contracts.OperatorConversationStateSchema.parse(await f.tool('operator_chat_get', {
      conversationId: row.conversationId }))
  }
  if (!row.readPath) throw new Error('The saved node transcript path is missing.')
  return agentChat.AgentChatStateSchema.parse(await f.request(row.readPath))
}

async function transcript(row: Row) {
  return (await conversation(row)).messages
}

async function compactionActivities(row: Row) {
  return (await conversation(row)).activities?.filter(activity => activity.title === 'Context compacted') ?? []
}

async function applyPreferences(row: Row, preferences: contracts.SessionPreferences) {
  const before = await idle(row)
  const changed = await change(row, { kind: 'preferences', preferences,
    requestId: randomUUID(), expectedRevision: before.revision })
  expect(changed.desired).toEqual(preferences)
  const applied = (await send(row, 'Reply only ACK without changing files.')).state
  expect(applied.nativeSessionId).toBe(before.nativeSessionId)
  expect(applied.applied).toEqual(preferences)
  expect(applied.applicability).toBe('applied')
  return applied
}

function contextInput() {
  return `The following are disposable reference notes. Preserve the earlier session marker. Do not repeat the notes; reply only ACK.\n${randomBytes(13000).toString('hex')}`
}

async function verifyNativeControls(row: Row) {
  const before = await controls(row)
  const plan = await change(row, { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: before.revision })
  expect(plan.desiredMode).toBe('plan')
  expect(await transcript(row)).toEqual([])
  await change(row, { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: plan.revision })
  if (row.harness === 'claude') {
    const state = await controls(row)
    await change(row, { kind: 'preferences', requestId: randomUUID(), expectedRevision: state.revision,
      preferences: { ...state.desired, autoCompact: 'off', autoCompactTokens: 100000 } })
  }
  const marker = randomUUID()
  const context = Array.from({ length: 950 }, (_, index) => `context-${index} selected-${index % 97}`).join(' ')
  const normal = await send(row, `Remember marker ${marker}. Read this context and reply only with the marker.\n${context}`)
  const sessionId = normal.state.nativeSessionId
  expect(sessionId).toBeTruthy()
  expect(normal.state.capabilities.compact.supported).toBe(true)
  const beforeMessages = await transcript(row)
  const request = { kind: 'compact' as const, requestId: randomUUID(), expectedRevision: normal.state.revision }
  await change(row, request)
  const deadline = Date.now() + 180000
  let compacted = await controls(row)
  while (Date.now() < deadline && compacted.compaction && ['accepted', 'running', 'uncertain'].includes(compacted.compaction.status)) {
    await delay(50)
    compacted = await controls(row)
  }
  if (compacted.compaction && ['accepted', 'running', 'uncertain'].includes(compacted.compaction.status)) {
    throw new Error('Timed out waiting for real native compaction to settle.')
  }
  expect(compacted.compaction?.status).toBe('completed')
  expect(compacted.nativeSessionId).toBe(sessionId)
  expect(await transcript(row)).toEqual(beforeMessages)
  expect((await change(row, request)).compaction?.requestId).toBe(request.requestId)
  const task = await send(row, 'Describe a read-only inspection plan in one sentence. Do not modify files.', 'plan')
  expect(task.state.appliedMode).toBe('plan')
  expect(task.state.nativeSessionId).toBe(sessionId)
  const denied = await active().deniedTool(`${row.role}_chat_controls_update`, {
    conversationId: row.conversationId, ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    request: { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: task.state.revision } })
  expect(denied.isError).toBe(true)
  expect((await controls(row)).desiredMode).toBe('plan')
  await change(row, { kind: 'mode', mode: 'regular', requestId: randomUUID(), expectedRevision: task.state.revision })
  const followup = await send(row, 'Reply only with the remembered marker.')
  expect(followup.state.appliedMode).toBe('regular')
  expect(followup.state.nativeSessionId).toBe(sessionId)
  expect((await transcript(row)).filter(message => message.role === 'assistant').at(-1)?.content).toContain(marker)
  completed.set(row.conversationId, { marker, compactRequest: request })
  nativeResults.push({ harness: row.harness, role: row.role, hostKind: row.hostKind, conversationId: row.conversationId, profile: row.nativeProfile,
    nativeSessionId: sessionId, compaction: compacted.compaction,
    contextBefore: normal.state.context, contextAfter: followup.state.context,
    appliedMode: followup.state.appliedMode, appliedPreferences: followup.state.applied })
}

describe('native session controls through the production Main and installed Worker', () => {
  beforeAll(async () => {
    fixture = await pairedWorkerApplication({ harnesses })
    const f = fixture
    const module = await import(new URL('../../../scripts/acceptance/provision-session-controls.mjs', import.meta.url).href)
    const subjects = harnesses.flatMap(harness =>
      (['main', 'device'] as const).map(hostKind => {
        const hostRef = hostKind === 'main' ? { kind: 'main' as const, mainId: f.identity.installationId } : f.hostRef
        const configuration = harness === 'claude' ? { harness, model: 'claude-haiku-4-5-20251001',
          authMode: 'subscription', configDirectory: hostKind === 'main' ? f.mainProfile : f.workerProfile,
          permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Write', 'mcp__foreman-code__workspace_list'],
          permissionRules: [], instructions: '', mcpServers: { 'foreman-code': { type: 'http', url: `${f.baseUrl}/mcp` } } }
          : structuredClone(contracts.DEFAULT_HARNESS_DEFAULTS[harness])
        if (configuration.harness === 'codex') {
          configuration.model = process.env.CODEX_MODEL ?? 'gpt-5.6-luna'
          configuration.reasoningEffort = 'medium'
        }

        return { hostRef, configuration, parentPath: f.mainProjects,
          ...(hostKind === 'device' ? { rootSelection: { hostRef, allowedBaseId: f.roots.bases[0]!.baseId,
            configurationRevision: f.roots.configurationRevision, relativePath: '',
            accessMode: harness === 'codex' ? 'read-only' : 'read-write' } } : {}) }
      }))
    const prepared: unknown = await module.provisionSessionControlMatrix({ subjects, harnesses, expectedIdentity: f.identity,
      baseUrl: f.baseUrl, browserOrigin: f.browserOrigin, sourceCommit: f.sourceCommit }, {
      contracts, agentChat, management, profiles, placements, workflows, roots, boundLocations,
      identity: f.identity, tool: f.tool, read: f.request,
    })
    const matrix = prepared as { rows: Row[] }
    expect(matrix.rows).toHaveLength(combinations.length)
    rows = matrix.rows
    expect(new Set(rows.map(row => row.conversationId)).size).toBe(combinations.length)
  }, 1800000)

  afterAll(async () => {
    try { await fixture?.close() }
    catch (cleanupError) {
      try { await saveEvidence(false) }
      catch (reportError) { throw new AggregateError([cleanupError, reportError], 'Native cleanup and evidence saving failed.', { cause: reportError }) }
      throw cleanupError
    }
    await saveEvidence(fixture !== undefined)
  }, 180000)

  it.each(combinations)('$harness $role on $hostKind compacts its existing native session and plans one task', async key => {
    const row = rows.find(value => value.harness === key.harness && value.role === key.role && value.hostKind === key.hostKind)
    if (!row) throw new Error('The native matrix row is missing.')
    await verifyNativeControls(row)
  }, 600000)

  it.each(combinations.filter(key => key.harness === 'claude'))(
    'claude $role on $hostKind applies context settings and automatically compacts at its accepted budget', async key => {
      const row = rows.find(value => value.harness === key.harness && value.role === key.role && value.hostKind === key.hostKind)!
      if (!completed.has(row.conversationId)) await verifyNativeControls(row)
      const before = await idle(row)
      expect(before.capabilities.autoCompact.supported).toBe(true)
      expect(before.capabilities.autoCompactBudget.supported).toBe(true)
      expect(before.capabilities.modelCapacity).toBeGreaterThanOrEqual(100000)
      const off = { ...before.desired, autoCompact: 'off' as const, autoCompactTokens: 100000 }
      let state = await applyPreferences(row, off)
      const offBoundaries = await compactionActivities(row)
      for (let index = 0; index < 24 && (state.context?.usedTokens ?? 0) <= 100000; index++) {
        state = (await send(row, contextInput())).state
        expect(await compactionActivities(row)).toEqual(offBoundaries)
      }
      expect(state.context?.usedTokens).toBeGreaterThan(100000)
      const offContext = state.context
      expect(state.context?.nativeSessionId).toBe(before.nativeSessionId)
      expect(state.capabilities.modelCapacity).toBe(before.capabilities.modelCapacity)
      const manual = await change(row, { kind: 'compact', requestId: randomUUID(), expectedRevision: state.revision })
      const deadline = Date.now() + 180000
      let compacted = await controls(row)
      while (Date.now() < deadline && compacted.compaction && ['accepted', 'running', 'uncertain'].includes(compacted.compaction.status)) {
        await delay(50)
        compacted = await controls(row)
      }
      if (compacted.compaction && ['accepted', 'running', 'uncertain'].includes(compacted.compaction.status)) {
        throw new Error('Timed out waiting for manual Claude compaction with automatic compaction Off.')
      }
      expect(compacted.compaction?.requestId).toBe(manual.compaction?.requestId)
      expect(compacted.compaction?.status).toBe('completed')
      expect(compacted.nativeSessionId).toBe(before.nativeSessionId)
      for (const profile of before.capabilities.contextProfiles) {
        const selected = await applyPreferences(row, { ...off, contextProfile: profile.id })
        expect(selected.capabilities.modelCapacity).toBe(profile.capacity)
      }
      const on = { ...off, autoCompact: 'on' as const, contextProfile: null }
      await applyPreferences(row, on)
      const baseline = new Set((await compactionActivities(row)).map(activity => activity.id))
      let automatic = false
      for (let index = 0; index < 24 && !automatic; index++) {
        state = (await send(row, contextInput())).state
        automatic = (await compactionActivities(row)).some(activity => !baseline.has(activity.id))
      }
      expect(automatic).toBe(true)
      expect(state.nativeSessionId).toBe(before.nativeSessionId)
      expect(state.applied?.autoCompactTokens).toBe(100000)
      const defaults = await applyPreferences(row, { ...on, autoCompact: 'default', autoCompactTokens: null })
      settingsResults.push({ ...key, conversationId: row.conversationId, nativeSessionId: before.nativeSessionId,
        offContext, autoCompactTokens: 100000, manualCompaction: compacted.compaction,
        testedContextProfiles: before.capabilities.contextProfiles,
        automaticActivityIds: (await compactionActivities(row)).filter(activity => !baseline.has(activity.id))
          .map(activity => activity.id), defaultPreferences: defaults.applied })
    }, 1800000)

  it('restores the selected native chats and compact receipts after Main closes and starts again', async () => {
    for (const row of rows) {
      if (!completed.has(row.conversationId)) await verifyNativeControls(row)
    }
    expect(completed.size).toBe(combinations.length)
    const snapshots = new Map<string, { state: contracts.SessionControlState; messages: Awaited<ReturnType<typeof transcript>> }>()
    for (const row of rows) {
      snapshots.set(row.conversationId, { state: await idle(row), messages: await transcript(row) })
    }
    await active().restartMain()
    const checkedProfiles = new Set<string>()
    for (const row of rows) {
      if (!checkedProfiles.has(row.nativeProfile)) {
        const checked = profiles.HostHarnessInstanceCheckResultSchema.parse(await active().tool('harness_instance_check', {
          ...row.profileCheckRequest, commandId: randomUUID(),
        }))
        expect(checked.value.instanceId).toBe(row.nativeProfile)
        expect(checked.proof.qualified).toBe(true)
        checkedProfiles.add(row.nativeProfile)
      }
      const before = snapshots.get(row.conversationId)!
      const recovered = await controls(row)
      expect(recovered.nativeSessionId).toBe(before.state.nativeSessionId)
      expect(recovered.desired).toEqual(before.state.desired)
      expect(recovered.desiredMode).toBe('regular')
      expect(recovered.compactions).toEqual(before.state.compactions)
      expect(await transcript(row)).toEqual(before.messages)
      const accepted = completed.get(row.conversationId)!
      const replay = await change(row, accepted.compactRequest)
      expect(replay.compactions).toEqual(before.state.compactions)
      const followup = await send(row, 'Reply only with the remembered marker.')
      expect(followup.state.nativeSessionId).toBe(before.state.nativeSessionId)
      expect(followup.state.appliedMode).toBe('regular')
      expect(followup.state.applied).toEqual(before.state.desired)
      expect((await transcript(row)).filter(message => message.role === 'assistant').at(-1)?.content)
        .toContain(accepted.marker)
      recoveredConversations.add(row.conversationId)
    }
  }, 1800000)
})
