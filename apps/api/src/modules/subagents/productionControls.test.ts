import { describe, expect, it, vi } from 'vitest'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../interactions/runtimePorts.js'
import type { RunOwnership } from '../runs/ownership.js'
import { productionSubagentControls } from './productionControls.js'

const context = { harness: 'codex' as const, executionId: 'execution', agentId: 'agent', workingDirectory: '/fixture',
  runId: 'run', attempt: 1, configuration: { id: 'configuration', workspaceId: 'workspace' } as AgentConfigurationVersion }
const child = { id: 'child', workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version', runId: 'run',
  parentExecutionId: 'execution', parentAttemptKey: 'execution:1', parentAgentId: 'agent', parentNodeId: 'node', parentSubagentId: null,
  provider: 'codex', nativeMode: 'codex-collab', native: { parentSessionId: 'root', childSessionId: 'native-child' },
  profile: { deviceId: 'main', harnessInstanceId: 'configuration', providerVersion: '0.154.0' } } as RunSubagent
function fixture(harness: 'codex' = 'codex') {
  let live = true
  const owner = { runId: 'run', assertOwned() { if (!live) throw new Error('lost') } } as RunOwnership
  const send = vi.fn(async () => {})
  const native = { harness, subagentControl: vi.fn((_child, assertOwner) => ({ generation: 'native-generation', nativeTurnId: null,
    matches: () => true, assertCurrent: assertOwner, sendInput: send })) } as unknown as NativeHarnessSessionManager
  const create = vi.fn(() => native)
  const managers = new ExecutionScopedNativeSessionManagerResolver(create)
  const resolved = managers.resolve({ ...context, harness }, owner)
  return { managers, resolved, create, native, send, owner, lose: () => { live = false }, controls: productionSubagentControls(managers) }
}
describe('production native child control resolution', () => {
  it.each(['codex-multi-agent-v2', 'codex-collab'] as const)('resolves %s only from its resident admitted manager', nativeMode => {
    const f = fixture('codex')
    const codexChild = { ...child, provider: 'codex' as const, nativeMode,
      profile: { ...child.profile, providerVersion: '0.154.0' } }
    expect(f.controls(codexChild)).toBeUndefined()
    f.resolved.beginStart!()
    f.resolved.markResident!()
    const lease = f.controls(codexChild)!
    expect(lease).toBeDefined()
    expect(f.native.subagentControl).toHaveBeenCalledTimes(1)
    f.lose()
    expect(lease.matches(codexChild)).toBe(false)
    expect(() => lease.assertCurrent()).toThrow()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('never allocates on a read and exposes only a resident exact execution attempt', () => {
    const f = fixture()
    expect(f.controls(child)).toBeUndefined()
    f.resolved.beginStart!(); f.resolved.markResident!()
    expect(f.controls(child)).toBeDefined()
    for (const override of [{ runId: 'other' }, { parentAttemptKey: 'execution:2' }, { parentAgentId: 'other' },
      { parentExecutionId: 'unknown' }, { profile: { ...child.profile, harnessInstanceId: 'other' } }]) {
      expect(f.controls({ ...child, ...override })).toBeUndefined()
    }
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('invalidates a captured lease when the Run owner is replaced on the same manager', () => {
    const f = fixture()
    f.resolved.beginStart!(); f.resolved.markResident!()
    const before = f.controls(child)!
    const next = { runId: 'run', assertOwned() {} } as RunOwnership
    f.managers.adoptOwner('execution', f.native, next)
    expect(before.matches(child)).toBe(false)
    expect(() => before.assertCurrent()).toThrow()
    expect(f.controls(child)!.generation).not.toBe(before.generation)
    f.managers.adoptOwner('execution', f.native, f.owner)
    expect(before.matches(child)).toBe(false)
    expect(f.controls(child)!.generation).not.toBe(before.generation)
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('rejects identity changes, release and owner loss without returning a stale control', () => {
    const f = fixture()
    f.resolved.beginStart!(); f.resolved.markResident!()
    const lease = f.controls(child)!
    expect(lease.matches({ ...child, native: { ...child.native, childSessionId: 'other' } })).toBe(false)
    f.lose()
    expect(f.controls(child)).toBeUndefined()
    expect(lease.matches(child)).toBe(false)
    f.managers.release(context, f.native)
    expect(f.controls(child)).toBeUndefined()
  })
})
