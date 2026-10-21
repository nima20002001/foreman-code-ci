import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HarnessConfigurationCheckResultSchema } from '@foreman-code/contracts/management'
import { CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { currentWorkflowFixture as makeWave25Fixture } from '../mocks/currentWorkflow'

import { ApiError, ApiClient, apiClient } from './client'
import { resetMockFixtures, setMockScenario } from '../mocks/scenarios'

describe('Phase 1 API boundary', () => {
  afterEach(() => {
    setMockScenario('normal')
    resetMockFixtures()
  })

  it('parses workspace details and keeps scoped query identities available to callers', async () => {
    const result = await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })

    expect(result.workspace).toMatchObject({ id: 'workspace-1', name: 'Website' })
    expect(result.agents.map((agent) => agent.name)).toEqual([
      'Operator',
      'Researcher',
      'Developer',
      'Reviewer',
    ])
    expect(result.workflows[0]?.edges).toEqual([
      { id: 'edge-researcher-developer', kind: 'execution', source: 'node-researcher', target: 'node-developer' },
      { id: 'edge-developer-reviewer', kind: 'execution', source: 'node-developer', target: 'node-reviewer' },
    ])
  })

  it('normalizes an API error response into ApiError', async () => {
    setMockScenario('error')

    await expect(apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'MOCK_READ_FAILED',
      status: 503,
    })
    expect(ApiError.is(new ApiError({ code: 'TEST', message: 'test' }))).toBe(true)
  })

  it('serves and revision-checks managed settings in mock mode', async () => {
    const agents = await apiClient.getManagedAgentDefaults()
    const workflows = await apiClient.getManagedWorkflowDefaults()
    expect(agents).toEqual({ value: DEFAULT_AGENT_DEFAULTS, revision: 0, versionId: null })
    expect(workflows).toEqual({ value: { approvalHandler: 'native' }, revision: 0, versionId: null })

    const next = structuredClone(DEFAULT_AGENT_DEFAULTS)
    next.operator.uiEnabled = false
    const updated = await apiClient.updateManagedAgentDefaults({
      commandId: 'mock-agent-defaults-update', expectedRevision: 0, value: next,
    })
    expect(updated).toMatchObject({ value: { value: next, revision: 1 }, replayed: false })
    await expect(apiClient.updateManagedAgentDefaults({
      commandId: 'stale-agent-defaults-update', expectedRevision: 0, value: DEFAULT_AGENT_DEFAULTS,
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 })
  })

  it('covers the Harness and workspace settings requests used in mock mode', async () => {
    const catalog = await apiClient.getManagedHarnessCatalog()
    expect(catalog.map((entry) => entry.harness)).toEqual(['codex'])
    expect(catalog.every((entry) => entry.defaultsRevision === 0)).toBe(true)

    const checked = await apiClient.request(
      '/api/management/harnesses/validate',
      HarnessConfigurationCheckResultSchema,
      { method: 'POST', body: { configuration: DEFAULT_HARNESS_DEFAULTS.codex } },
    )
    expect(checked).toMatchObject({ configuration: DEFAULT_HARNESS_DEFAULTS.codex, qualification: { ready: true, version: 'mock' } })

    const workspace = await apiClient.getManagedWorkspace('workspace-1')
    expect(workspace).toMatchObject({ workspace: { id: 'workspace-1' }, locationValidation: { status: 'unconfigured' } })
    await expect(apiClient.validateWorkspaceLocation({
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: '/workspace', accessMode: 'read-only',
    })).resolves.toMatchObject({ workspaceId: 'workspace-1', location: { rootPath: '/workspace' } })
    await expect(apiClient.getScopedMcpDetection('workspace-1', 'codex')).resolves.toMatchObject({
      runnerId: 'runner-local', detection: { harness: 'codex', state: 'not_detected' },
    })
  })

  it('passes AbortSignal through to fetch', async () => {
    const controller = new AbortController()
    const signal = controller.signal
    let receivedSignal: AbortSignal | null | undefined
    const client = new ApiClient({
      fetch: async (_input, init) => {
        receivedSignal = init?.signal
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    await client.listAgents({ workspaceId: 'workspace-1' }, { signal })
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(receivedSignal?.aborted).toBe(false)
    controller.abort('caller cancelled')
    expect(receivedSignal?.aborted).toBe(true)
    expect(receivedSignal?.reason).toBe('caller cancelled')
  })

  it('parses complete-definition Save and its exact HTTP replay', async () => {
    const fixture = makeWave25Fixture('web-save')
    const value = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
      revision: 9, currentVersionId: fixture.version.id, version: fixture.version }
    const response = (replayed: boolean) => new Response(JSON.stringify({ value, replayed }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true))
    const client = new ApiClient({ fetch })
    const input = { commandId: 'save-exact', executionSemanticsVersion: 3, expectedRevision: 8,
      expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
      graph: fixture.version.definition }
    const path = `/api/management/workspaces/${value.workspaceId}/workflows/${value.workflowId}/definition`
    expect(await client.request(path, CurrentWorkflowSaveResultSchema, { method: 'PUT', body: input })).toEqual({ value, replayed: false })
    expect(await client.request(path, CurrentWorkflowSaveResultSchema, { method: 'PUT', body: input })).toEqual({ value, replayed: true })
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([input, input])
  })
})

it.each(['headers', 'body'])('bounds an Operator send when its response %s never settles and aborts the transport', async phase => {
  const state = (await import('../../features/operator-chat/pr17-test-fixtures')).operatorState({
    turnState: 'idle', activeRequestId: null,
  })
  let receivedSignal: AbortSignal | undefined
  let finishHeaders: ((response: Response) => void) | undefined
  let finishBody: ReadableStreamDefaultController | undefined
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    receivedSignal = init?.signal ?? undefined
    if (phase === 'headers') return await new Promise<Response>(resolve => { finishHeaders = resolve })
    return new Response(new ReadableStream({ start(controller) { finishBody = controller } }),
      { headers: { 'content-type': 'application/json' } })
  })
  const client = new ApiClient({ fetch })
  vi.useFakeTimers()
  try {
    const sending = client.sendOperatorMessage(state.conversation.id, { requestId: 'same-request', content: 'Continue' },
      { timeoutMs: 100 })
    const rejection = expect(sending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(100)
    await rejection
    expect(receivedSignal?.aborted).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
  } finally {
    finishHeaders?.(new Response('{}'))
    finishBody?.close()
    vi.useRealTimers()
  }
})
