import { expect, it, vi } from 'vitest'
import type { McpDetection, NativeHarnessCapabilities } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import { remoteMcpPreflight } from './remoteMcpPreflight.js'

function fixture() {
  const detection: McpDetection = {
    harness: 'codex', serverName: 'graphql', state: 'authentication_required',
    endpointMatches: true, credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
    credentialArrangement: { kind: 'environment_variable', environmentVariable: 'GRAPHQL_MCP_TOKEN' },
    checkedAt: new Date().toISOString(),
  }
  const manager = {
    harness: 'codex', inspectMcp: vi.fn(async () => detection),
    capabilities: vi.fn(async () => ({ provider: 'codex', providerVersion: '0.154.0' } as NativeHarnessCapabilities)),
  }
  const context = { harness: 'codex', workingDirectory: '/accepted/worker/tree' } as NativeManagerResolutionContext
  const service = remoteMcpPreflight(manager as unknown as NativeHarnessSessionManager, context)
  const input = { harness: 'codex' as const, runnerId: 'runner-local', workingDirectory: context.workingDirectory }
  return { detection, manager, service, input }
}

it.each(['connected', 'authentication_required', 'status_unavailable'] as const)(
  'accepts authenticated remote configuration in state %s before issuing its credential', async state => {
    const f = fixture()
    f.detection.state = state
    expect(await f.service.preflight(f.input)).toMatchObject({
      detection: f.detection, workingDirectory: '/accepted/worker/tree', providerVersion: '0.154.0',
    })
    expect(f.manager.inspectMcp).toHaveBeenCalledOnce()
  },
)

it.each(['endpoint', 'credential', 'arrangement', 'harness', 'server', 'broken', 'missing'] as const)(
  'refuses remote %s mismatches', async defect => {
    const f = fixture()
    if (defect === 'endpoint') f.detection.endpointMatches = false
    if (defect === 'credential') f.detection.credentialEnvironmentVariable = null
    if (defect === 'arrangement') f.detection.credentialArrangement = { kind: 'unknown' }
    if (defect === 'harness') f.detection.harness = 'claude'
    if (defect === 'server') f.detection.serverName = 'another-server'
    if (defect === 'broken') f.detection.state = 'broken'
    if (defect === 'missing') f.detection.state = 'not_detected'
    await expect(f.service.preflight(f.input)).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    expect(f.manager.capabilities).not.toHaveBeenCalled()
  },
)

it('rejects a different execution directory before remote inspection', async () => {
  const f = fixture()
  await expect(f.service.preflight({ ...f.input, workingDirectory: '/other' }))
    .rejects.toMatchObject({ code: 'MCP_INSPECTION_CONTEXT_MISMATCH' })
  expect(f.manager.inspectMcp).not.toHaveBeenCalled()
})

it.each([
  ['graphql', 'GRAPHQL_MCP_TOKEN'],
  ['foreman-code', 'FOREMAN_CODE_MCP_TOKEN'],
] as const)('accepts supported remote %s identity and %s credential without changing placement', async (serverName, tokenName) => {
  const f = fixture()
  f.detection.serverName = serverName
  f.detection.credentialEnvironmentVariable = tokenName
  f.detection.credentialArrangement = { kind: 'environment_variable', environmentVariable: tokenName }
  expect(await f.service.preflight(f.input)).toMatchObject({ detection: f.detection, runnerId: f.input.runnerId,
    workingDirectory: f.input.workingDirectory })
})
