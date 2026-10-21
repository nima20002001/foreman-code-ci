import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, HarnessExecutionRequestSchema,
  type NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { createAdmittedNativeManager } from './admittedManager.js'
import type { NativeHarnessSessionManager } from './port.js'
import { productionSelectedProfileManager } from './selectedProfileProduction.js'

type Input = Parameters<typeof productionSelectedProfileManager>[0]

function fixture(nativeSessionId?: string) {
  const session: NativeSessionReference = { harness: 'codex', providerVersion: '1.0.0',
    nativeSessionId: 'original-session' }
  const configuration = DEFAULT_HARNESS_DEFAULTS.codex
  const start = { request: HarnessExecutionRequestSchema.parse({ executionId: 'execution', runId: 'run',
    workspaceId: 'workspace', workflowNodeId: 'node', workingDirectory: '/project', runtimeDirectory: '/runtime',
    input: {}, configuration: AgentConfigurationVersionSchema.parse({
      id: 'configuration', agentId: 'agent', workspaceId: 'workspace', version: 1, productRole: 'orchestrator',
      harness: configuration, prompt: {}, assignedSkills: [], contentHash: 'sha256:profile-fixture',
      createdAt: '2026-10-01T00:00:00.000Z',
    }) }) }
  const accepted = { override: { configuration, target: { hostRef: { kind: 'main', mainId: 'main' } } } }
  const admit = vi.fn(async () => accepted)
  const native = { harness: 'codex', attachSession: vi.fn(async () => session),
    createSession: vi.fn(async () => session), dispose: vi.fn(async () => {}) } as unknown as NativeHarnessSessionManager
  const allocate = vi.fn(async () => ({ manager: native }))
  const factories = { allocateAdmitted(harness: 'codex', prepare: Parameters<Input['factories']['allocateAdmitted']>[1]) {
    return createAdmittedNativeManager(harness, async signal => {
      await prepare(signal)
      return allocate()
    })
  } }
  const manager = productionSelectedProfileManager({
    factories: factories as unknown as Input['factories'],
    registry: { pinOverride: () => ({ instance: {} }) } as unknown as Input['registry'],
    profiles: { admit, revalidate: vi.fn(async () => {}) } as unknown as Input['profiles'],
    selector: {} as Input['selector'], binding: {} as Input['binding'], configuration,
    role: 'workflow', workingDirectory: '/project', ownerAgentId: 'agent',
    recovery: {} as Input['recovery'], appMcpAccess: 'scoped',
    ...(nativeSessionId ? { nativeSessionId } : {}),
  }).manager
  return { manager, native, session, start, admit, allocate }
}

describe('selected profile admission during original session recovery', () => {
  it('waits for automatic qualification before allocating the original session adapter', async () => {
    const f = fixture('original-session')
    f.admit.mockRejectedValueOnce(new DomainError('HARNESS_PROFILE_CHECK_PENDING', 'Checking profile', 503))
    try {
      expect(await f.manager.attachSession(f.session, f.start)).toEqual(f.session)
      expect(f.admit).toHaveBeenCalledTimes(2)
      expect(f.allocate).toHaveBeenCalledTimes(1)
      expect(f.native.attachSession).toHaveBeenCalledTimes(1)
      expect(f.native.createSession).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose?.()
    }
  })

  it.each([undefined, 'original-session'])('keeps permanent admission failures with saved session %s', async id => {
    const f = fixture(id)
    f.admit.mockRejectedValue(new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Profile unavailable', 409))
    try {
      await expect(f.manager.attachSession(f.session, f.start))
        .rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
      expect(f.admit).toHaveBeenCalledTimes(1)
      expect(f.allocate).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose?.()
    }
  })

  it('keeps new session admission pending instead of waiting or allocating', async () => {
    const f = fixture()
    f.admit.mockRejectedValue(new DomainError('HARNESS_PROFILE_CHECK_PENDING', 'Checking profile', 503))
    try {
      await expect(f.manager.createSession(f.start)).rejects.toMatchObject({
        operation: 'session_creation', delivery: 'not_sent',
        result: { outcome: 'failed', error: { code: 'HARNESS_PROFILE_CHECK_PENDING' } },
      })
      expect(f.admit).toHaveBeenCalledTimes(1)
      expect(f.allocate).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose?.()
    }
  })

  it('drains a pending recovery on disposal without allocating a native adapter', async () => {
    const f = fixture('original-session')
    let attempted!: () => void
    const attempt = new Promise<void>(resolve => { attempted = resolve })
    f.admit.mockImplementation(async () => {
      attempted()
      throw new DomainError('HARNESS_PROFILE_CHECK_PENDING', 'Checking profile', 503)
    })
    const attached = expect(f.manager.attachSession(f.session, f.start))
      .rejects.toMatchObject({ cause: { code: 'NATIVE_MANAGER_DISPOSED' } })
    await attempt
    await f.manager.dispose?.()
    await attached
    expect(f.allocate).not.toHaveBeenCalled()
    expect(f.native.attachSession).not.toHaveBeenCalled()
  })
})
