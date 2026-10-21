import { Client, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callCiTool, callCiToolResult, connectCiOperator, disableCiProfiles,
  qualifyCiProfile } from './helpers/crossComputerCiSetup.js'
import { ciHarness } from './helpers/crossComputerCiGraph.js'

const success = { content: [], structuredContent: { accepted: true } }
function failure(code: string) {
  return { isError: true, content: [{ type: 'text' as const,
    text: JSON.stringify({ error: { code, message: code } }) }] }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scenario MCP recovery', () => {
  it.each([SdkErrorCode.RequestTimeout, SdkErrorCode.ConnectionClosed, SdkErrorCode.NotConnected])(
    'retries a placement-choice read after %s without a mutation command ID', async code => {
      const args = { workspaceId: 'workspace', workflowId: 'workflow', nodeId: 'node' }
      const callTool = vi.fn<Client['callTool']>()
        .mockRejectedValueOnce(new SdkError(code, 'Transport interrupted'))
        .mockResolvedValue(success)
      const pending = expect(callCiTool({ callTool }, 'workflow_node_placement_choices', args))
        .resolves.toEqual({ accepted: true })
      await Promise.all([pending, vi.runAllTimersAsync()])
      expect(callTool.mock.calls.map(([request]) => request.arguments)).toEqual([args, args])
    })

  it.each([502, 503])('recovers a read after SDK HTTP %s', async status => {
    const callTool = vi.fn<Client['callTool']>()
      .mockRejectedValueOnce(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Gateway unavailable', { status }))
      .mockResolvedValue(success)
    const pending = expect(callCiTool({ callTool }, 'run_get', { runId: 'run' }))
      .resolves.toEqual({ accepted: true })
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it.each([502, 503])('reuses the mutation command and payload after SDK HTTP %s', async status => {
    const args = { runId: 'run', commandId: 'original-command' }
    const callTool = vi.fn<Client['callTool']>()
      .mockRejectedValueOnce(new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Gateway unavailable', { status }))
      .mockResolvedValue(success)
    const pending = expect(callCiToolResult({ callTool }, 'run_stop', args)).resolves.toEqual(success)
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(callTool.mock.calls.map(([request]) => request.arguments)).toEqual([args, args])
  })

  it.each([502, 503])('does not replay a mutation without a command ID after SDK HTTP %s', async status => {
    const error = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Gateway unavailable', { status })
    const callTool = vi.fn<Client['callTool']>().mockRejectedValue(error)
    await expect(callCiToolResult({ callTool }, 'workflow_create', {})).rejects.toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it.each([400, 401, 403, 404, 409, 500])('does not retry SDK HTTP %s', async status => {
    const error = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'HTTP operation failed', { status })
    const callTool = vi.fn<Client['callTool']>().mockRejectedValue(error)
    await expect(callCiToolResult({ callTool }, 'run_get', {})).rejects.toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it.each([502, 503])('stops repeated SDK HTTP %s failures at the supplied deadline', async status => {
    const started = Date.now()
    const callTool = vi.fn<Client['callTool']>().mockRejectedValue(
      new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, 'Gateway unavailable', { status }))
    const pending = expect(callCiToolResult({ callTool }, 'run_get', {}, { deadline: started + 2500 }))
      .rejects.toThrow('Timed out')
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(Date.now() - started).toBe(2500)
    expect(callTool).toHaveBeenCalledTimes(3)
  })

  it.each([SdkErrorCode.RequestTimeout, SdkErrorCode.ConnectionClosed, SdkErrorCode.NotConnected])(
    'recovers a transient %s read without recording a permanent error', async code => {
      const callTool = vi.fn<Client['callTool']>()
        .mockRejectedValueOnce(new SdkError(code, 'Transport interrupted'))
        .mockResolvedValue(success)
      const pending = expect(callCiTool({ callTool }, 'run_get', { runId: 'run' }))
        .resolves.toEqual({ accepted: true })
      await Promise.all([pending, vi.runAllTimersAsync()])
      expect(callTool).toHaveBeenCalledTimes(2)
    })

  it('reconnects the authenticated client once for concurrent disconnected reads', async () => {
    const connect = vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    vi.spyOn(Client.prototype, 'close').mockResolvedValue(undefined)
    let connected = false
    const calls = vi.spyOn(Client.prototype, 'callTool').mockImplementation(async () => {
      if (!connected) throw new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed')
      return success
    })
    connect.mockImplementation(async () => { connected = true })
    const client = await connectCiOperator('https://example.invalid/mcp', 'synthetic-token')
    connected = false
    const pending = expect(Promise.all([
      callCiTool(client, 'run_get', { runId: 'first' }),
      callCiTool(client, 'ci_list', { runId: 'second' }),
    ])).resolves.toEqual([{ accepted: true }, { accepted: true }])
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(connect).toHaveBeenCalledTimes(2)
    expect(calls).toHaveBeenCalledTimes(4)
  })

  it('reconciles an uncertain mutation with its original command and payload', async () => {
    const args = { commandId: 'original-command', runId: 'run' }
    const callTool = vi.fn<Client['callTool']>()
      .mockRejectedValueOnce(Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue(success)
    const pending = expect(callCiToolResult({ callTool }, 'run_stop', args)).resolves.toEqual(success)
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(callTool.mock.calls.map(([request]) => request.arguments)).toEqual([args, args])
  })

  it('does not replay an uncertain mutation without a command ID', async () => {
    const error = new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out')
    const callTool = vi.fn<Client['callTool']>().mockRejectedValue(error)
    await expect(callCiToolResult({ callTool }, 'workflow_create', {})).rejects.toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it.each(['ACCESS_DENIED', 'VALIDATION_FAILED', 'WORKFLOW_BROKEN'])(
    'does not retry the product error %s', async code => {
      const callTool = vi.fn<Client['callTool']>().mockResolvedValue(failure(code))
      await expect(callCiTool({ callTool }, 'run_get', {})).rejects.toThrow(code)
      expect(callTool).toHaveBeenCalledTimes(1)
    })

  it('does not retry unexpected thrown failures', async () => {
    const error = new Error('Invalid product response')
    const callTool = vi.fn<Client['callTool']>().mockRejectedValue(error)
    await expect(callCiToolResult({ callTool }, 'run_get', {})).rejects.toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('bounds repeated transient failures to the existing five-minute allowance', async () => {
    const started = Date.now()
    const callTool = vi.fn<Client['callTool']>()
      .mockRejectedValue(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out'))
    const pending = expect(callCiToolResult({ callTool }, 'run_get', {})).rejects.toThrow('Timed out')
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(callTool.mock.calls.length).toBeGreaterThan(1)
    expect(Date.now() - started).toBeLessThanOrEqual(300_000)
  })

  it.each(['WORKFLOW_STOP_SETTLEMENT_PENDING', 'WORKFLOW_STOP_OWNER_UNCERTAIN'])(
    'retries %s with the same Stop command even for an already completed run', async code => {
      const args = { runId: 'completed-run', commandId: 'same-stop-command' }
      const callTool = vi.fn<Client['callTool']>().mockResolvedValueOnce(failure(code)).mockResolvedValue(success)
      const pending = expect(callCiToolResult({ callTool }, 'run_stop', args)).resolves.toEqual(success)
      await Promise.all([pending, vi.runAllTimersAsync()])
      expect(callTool.mock.calls.map(([request]) => request.arguments)).toEqual([args, args])
    })

  it('fails when Stop settlement remains pending beyond its deadline', async () => {
    const started = Date.now()
    const callTool = vi.fn<Client['callTool']>().mockResolvedValue(failure('WORKFLOW_STOP_SETTLEMENT_PENDING'))
    const pending = expect(callCiToolResult({ callTool }, 'run_stop', {
      runId: 'run', commandId: 'same-stop-command',
    })).rejects.toThrow('Timed out')
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(Date.now() - started).toBeLessThanOrEqual(300_000)
  })
})

it.each(['save', 'check'] as const)('retains cleanup ownership when profile %s fails', async stage => {
  const mainId = '11111111-1111-4111-8111-111111111111'
  const hostRef = { kind: 'main' as const, mainId }
  const owned = new Map<string, Pick<HarnessProfileSelection, 'instanceId' | 'target'>>()
  let saved: Record<string, unknown> | undefined
  const error = new Error('Profile operation failed')
  const callTool = vi.fn<Client['callTool']>(async request => {
    if (request.name === 'harness_registry_get') return { content: [], structuredContent: {
      hostMetadata: { hostRef, applicationInstallationId: mainId, connection: null, platform: null, workspaceRoots: null },
      instances: [], installations: [{ hostRef, harnessInstallationId: 'codex', installationFingerprint: 'installed',
        driverId: 'codex', driverRevision: '1', protocolRevision: '1', environmentGeneration: '1', connectionGeneration: '1',
        observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: null,
        launcher: { requested: 'codex', resolvedLauncher: '/bin/codex', fingerprint: 'installed', status: 'installed',
          interpreter: null, diagnostics: [], checkedAt: '2026-10-15T00:00:00.000Z',
          environment: { generation: '1', provenance: 'terminal', cwd: '/project', path: '/bin' } } }],
    } }
    if (request.name === 'harness_instance_save') {
      const value = Object.fromEntries(Object.entries(request.arguments!)
        .filter(([key]) => key !== 'commandId' && key !== 'expectedRevision'))
      saved = { ...value, revision: 1, instanceRevision: '1', driverId: 'codex',
        configurationFingerprint: 'profile', qualification: 'unqualified', configuration: ciHarness }
      if (stage === 'save' && value.enabled) throw error
      return { content: [], structuredContent: { value: saved, replayed: false } }
    }
    if (request.name === 'harness_instance_check') throw error
    if (request.name === 'harness_instances_list') return { content: [], structuredContent: { overrides: [saved] } }
    throw new Error(`Unexpected tool ${request.name}`)
  })
  const client = { callTool } as unknown as Client
  await expect(qualifyCiProfile(client, { name: 'Scenario computer', hostRef, registration: null }, owned))
    .rejects.toBe(error)
  expect(owned.size).toBe(1)
  expect([...owned.values()][0]).toMatchObject({ instanceId: saved!.instanceId, target: saved!.target })
  await disableCiProfiles(client, owned.values())
  expect(callTool.mock.calls.at(-1)?.[0]).toMatchObject({ name: 'harness_instance_save', arguments: { enabled: false } })
})

it('aborts an in-flight read at its deadline without retrying beyond it', async () => {
  const started = Date.now()
  const callTool = vi.fn<Client['callTool']>(async (_request, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(success), 60_000)
    options?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(options.signal!.reason)
    }, { once: true })
  }))
  const pending = expect(callCiToolResult({ callTool }, 'run_get', {}, { deadline: started + 10_000 }))
    .rejects.toThrow('Timed out')
  await Promise.all([pending, vi.runAllTimersAsync()])
  expect(Date.now() - started).toBe(10_000)
  expect(callTool).toHaveBeenCalledTimes(1)
})
