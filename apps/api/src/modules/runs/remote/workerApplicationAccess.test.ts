import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { prepareWorkerApplicationAccess } from './workerApplicationAccess.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'

function fixture() {
  const mainId = randomUUID(), digest = 'a'.repeat(64)
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node', mainInstallationId: 'main-installation',
    hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, registration: { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`, owner: { grantId: 'grant', epoch: '1' } })
  const applicationAccess = { kind: 'scoped-worker-mcp' as const, token: 'exact-main-lease', executionId: intent.executionId, agentId: 'agent', operationId: intent.operationId, attemptId: intent.attemptId, bindingHash: intent.bindingHash }
  const lease = { version: 1, mainId, audience: 'worker', principalId: 'principal', executionId: intent.executionId, agentId: 'agent', operationId: intent.operationId, attemptId: intent.attemptId, bindingHash: intent.bindingHash, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  return { intent, placement, applicationAccess, lease }
}
describe('worker selected-main application lease with authenticated carrier doubles', () => {
  it.each(['backpressure', 'timeout'])('retries %s while authorizing the same application lease', async code => {
    vi.useFakeTimers()
    const value = fixture()
    const request = vi.fn<Parameters<typeof prepareWorkerApplicationAccess>[0]['request']>(async () => ({ payload: value.lease }))
    request.mockRejectedValueOnce(new DeviceApplicationError(code))
    try {
      const prepared = prepareWorkerApplicationAccess({ request }, value.intent, value.placement, value.applicationAccess)
      const checked = expect(prepared).resolves.toMatchObject({ environment: { agentId: 'agent' } })
      await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(5_000)])
      await checked
      expect(request).toHaveBeenCalledTimes(2)
      expect(request.mock.calls[1]).toEqual(request.mock.calls[0])
    } finally { vi.useRealTimers() }
  })

  it('retries a Main database read timeout for the lease and for a tool call that never reached Main MCP', async () => {
    vi.useFakeTimers()
    const value = fixture()
    const response = { statusCode: 200, contentType: 'application/json', body: '{"ok":true}' }
    const request = vi.fn<Parameters<typeof prepareWorkerApplicationAccess>[0]['request']>(async (_namespace, raw) =>
      ({ payload: (raw as { operation: string }).operation === 'worker-mcp.authorize' ? value.lease : response }))
    try {
      request.mockRejectedValueOnce(new DeviceApplicationError('DATABASE_READ_TIMEOUT'))
      const preparing = prepareWorkerApplicationAccess({ request }, value.intent, value.placement, value.applicationAccess)
      await Promise.allSettled([preparing, vi.advanceTimersByTimeAsync(5_000)])
      const prepared = await preparing
      request.mockRejectedValueOnce(new DeviceApplicationError('DATABASE_READ_TIMEOUT'))
      const called = prepared.request({ method: 'tools/call', params: { name: 'write' } })
      await Promise.allSettled([called, vi.advanceTimersByTimeAsync(5_000)])
      expect(await called).toEqual(response)
      expect(request).toHaveBeenCalledTimes(4)
    } finally { vi.useRealTimers() }
  })

  it('allows slow relay responses and never replays a tool call after its response times out', async () => {
    const value = fixture()
    const request = vi.fn<Parameters<typeof prepareWorkerApplicationAccess>[0]['request']>(async () => ({ payload: value.lease }))
    const prepared = await prepareWorkerApplicationAccess({ request }, value.intent, value.placement, value.applicationAccess)
    request.mockClear()
    request.mockRejectedValueOnce(new DeviceApplicationError('timeout'))
    await expect(prepared.request({ method: 'tools/call', params: { name: 'write' } }))
      .rejects.toMatchObject({ code: 'timeout' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![2]?.timeoutMs).toBeGreaterThanOrEqual(120_000)
  })

  it('authorizes the original lease before returning only its token and forwards every call to main', async () => {
    const value = fixture(), requests: unknown[] = []
    const prepared = await prepareWorkerApplicationAccess({ request: async (namespace, raw) => {
      expect(namespace).toBe('worker-mcp-v2'); requests.push(raw)
      return { payload: requests.length === 1 ? value.lease : { statusCode: 200, contentType: 'application/json', body: '{"ok":true}' } }
    } }, value.intent, value.placement, value.applicationAccess)
    expect(prepared.environment).toEqual({ agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: 'exact-main-lease' } })
    expect(await prepared.request({ method: 'tools/list' })).toEqual({ statusCode: 200, contentType: 'application/json', body: '{"ok":true}' })
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({ operation: 'worker-mcp.authorize', applicationAccess: value.applicationAccess })
    expect(requests[1]).toMatchObject({ operation: 'worker-mcp.request', applicationAccess: value.applicationAccess, body: { method: 'tools/list' } })
  })
  it.each(['wrong-attempt', 'expired', 'binary'])('rejects %s main authorization without native environment', async reason => {
    const value = fixture()
    const channel = { request: async () => ({ payload: { ...value.lease, ...(reason === 'wrong-attempt' ? { attemptId: 'other' } : {}), ...(reason === 'expired' ? { expiresAt: new Date(0).toISOString() } : {}) }, ...(reason === 'binary' ? { bytes: new Uint8Array(1) } : {}) }) }
    await expect(prepareWorkerApplicationAccess(channel, value.intent, value.placement, value.applicationAccess)).rejects.toThrow()
  })
  it('rejects another execution token before contacting the selected main', async () => {
    const value = fixture(); let requests = 0
    await expect(prepareWorkerApplicationAccess({ request: async () => { requests++; return { payload: value.lease } } }, value.intent, value.placement, { ...value.applicationAccess, executionId: 'other' })).rejects.toThrow('original accepted execution')
    expect(requests).toBe(0)
  })
  it('refreshes the same principal and token over twenty minutes', async () => {
    const value = fixture()
    const startedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    const requests: unknown[] = []
    let renewedExpiry = new Date(startedAt + 15 * 60_000).toISOString()
    try {
      const prepared = await prepareWorkerApplicationAccess({ request: async (_namespace, raw) => {
        requests.push(raw)
        return { payload: { ...value.lease, expiresAt: renewedExpiry } }
      } }, value.intent, value.placement, value.applicationAccess)
      const environment = prepared.environment
      for (const minute of [10, 20]) {
        clock.mockReturnValue(startedAt + minute * 60_000)
        renewedExpiry = new Date(Date.now() + 15 * 60_000).toISOString()
        expect(await prepared.refresh()).toBe(renewedExpiry)
        expect(prepared.expiresAt).toBe(renewedExpiry)
        expect(prepared.environment).toBe(environment)
      }
      expect(requests).toHaveLength(3)
      for (const request of requests) expect(request).toMatchObject({
        operation: 'worker-mcp.authorize', applicationAccess: value.applicationAccess,
      })
      expect(environment.variables.GRAPHQL_MCP_TOKEN).toBe(value.applicationAccess.token)
    } finally {
      clock.mockRestore()
    }
  })
  it.each(['principal', 'attempt', 'expiry', 'revoked'])('rejects changed %s on lease refresh', async defect => {
    const value = fixture()
    const request = vi.fn(async () => ({ payload: value.lease }))
    const prepared = await prepareWorkerApplicationAccess({ request }, value.intent, value.placement, value.applicationAccess)
    const expiresAt = prepared.expiresAt
    if (defect === 'principal') value.lease.principalId = 'replacement'
    if (defect === 'attempt') value.lease.attemptId = 'replacement'
    if (defect === 'expiry') value.lease.expiresAt = new Date(0).toISOString()
    if (defect === 'revoked') request.mockRejectedValueOnce(new Error('Lease revoked'))
    await expect(prepared.refresh()).rejects.toThrow()
    expect(prepared.expiresAt).toBe(expiresAt)
    expect(prepared.environment.variables.GRAPHQL_MCP_TOKEN).toBe(value.applicationAccess.token)
  })
  it('answers a relayed tool call stalled behind device admission with a retryable timeout before the native tool deadline', async () => {
    vi.useFakeTimers()
    const value = fixture()
    const request = vi.fn<Parameters<typeof prepareWorkerApplicationAccess>[0]['request']>(async () => ({ payload: value.lease }))
    try {
      const prepared = await prepareWorkerApplicationAccess({ request }, value.intent, value.placement, value.applicationAccess)
      request.mockImplementation((_namespace, _payload, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DeviceApplicationError('cancelled')), { once: true })
      }))
      let settled: unknown
      const called = prepared.request({ method: 'tools/call', params: { name: 'write' } }).catch(error => { settled = error })
      await vi.advanceTimersByTimeAsync(110_000)
      expect(settled).toMatchObject({ code: 'timeout', retryable: true })
      await called
    } finally { vi.useRealTimers() }
  })
})
