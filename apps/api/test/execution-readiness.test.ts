import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ExecutionReadinessService } from '../src/modules/harnesses/executionReadiness.js'
import type { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { DomainError } from '../src/modules/errors.js'

const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['harnesses:read'], scope: {} }] }
const catalog = (discoveryError: { code: string; message: string } | null = null) => ({ get: vi.fn(async () => ({ defaultsRevision: 7, discoveryError })) }) as unknown as Pick<HarnessCatalogService, 'get'>

describe('execution readiness', () => {
  it('checks the exact Operator profile separately from a blocked workflow preset', async () => {
    const source = catalog({ code: 'CLAUDE_PROFILE_SELECTION_REQUIRED', message: 'Workflow preset needs qualification.' })
    const inspect = vi.fn(async (_principal: ManagementPrincipal, configurationVersionId?: string) => ({
      configurationVersionId: configurationVersionId ?? 'current-operator', defaultsRevision: configurationVersionId ? null : 4,
      harness: { harness: 'claude' as const, model: 'native-model', effort: 'medium' as const, authMode: 'subscription' as const,
        configDirectory: '/unit/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
        tools: [], permissionRules: [], instructions: '', mcpServers: {} },
    }))
    const service = new ExecutionReadinessService(new NativeRollout({}), source, inspect)
    expect(await service.get(principal, 'claude')).toMatchObject({ status: 'blocked', scope: 'saved-harness-defaults' })
    expect(inspect).not.toHaveBeenCalled()
    expect(await service.get(principal, 'claude', 'operator-configuration')).toMatchObject({ status: 'eligible',
      scope: 'operator-configuration', configurationVersionId: 'current-operator', defaultsRevision: 4 })
    expect(await service.get(principal, 'claude', 'operator-configuration', 'accepted-old-config')).toMatchObject({ status: 'eligible',
      configurationVersionId: 'accepted-old-config', defaultsRevision: null })
    expect(inspect).toHaveBeenLastCalledWith(principal, 'accepted-old-config')
    expect(source.get).toHaveBeenCalledTimes(1)
  })
  it.each(['HARNESS_PROFILE_REQUIRED', 'HARNESS_PROFILE_UNAVAILABLE', 'OPERATOR_CONFIGURATION_NOT_FOUND', 'CLAUDE_POLICY_UNQUALIFIED'])(
    'reports %s from the selected Operator profile truthfully', async code => {
      const inspect = vi.fn(async () => { throw new DomainError(code, 'The selected Operator profile is unavailable.', 409) })
      expect(await new ExecutionReadinessService(new NativeRollout({}), catalog(), inspect).get(principal, 'claude', 'operator-configuration'))
        .toMatchObject({ status: 'blocked', scope: 'operator-configuration', reason: { code } })
    })
  it('denies ungranted Operator inspection and preserves live authorization failures', async () => {
    const inspect = vi.fn(async () => { throw new DomainError('ACCESS_DENIED', 'Live read grant removed.', 403) })
    const service = new ExecutionReadinessService(new NativeRollout({}), catalog(), inspect)
    await expect(service.get({ ...principal, grants: [] }, 'claude', 'operator-configuration')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(inspect).not.toHaveBeenCalled()
    await expect(service.get(principal, 'claude', 'operator-configuration')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })
  it('does not qualify a different Operator harness or configuration pin', async () => {
    const inspect = vi.fn(async () => ({ configurationVersionId: 'current-config', defaultsRevision: 4,
      harness: { harness: 'codex' as const, model: 'unit/model', reasoningEffort: 'medium' as const,
        sandbox: 'read-only' as const, serviceTier: 'standard' as const } }))
    const service = new ExecutionReadinessService(new NativeRollout({}), catalog(), inspect)
    expect(await service.get(principal, 'claude', 'operator-configuration')).toMatchObject({ status: 'blocked',
      reason: { code: 'OPERATOR_CONFIGURATION_CONFLICT' } })
    expect(await service.get(principal, 'codex', 'operator-configuration', 'historical-config')).toMatchObject({ status: 'blocked',
      reason: { code: 'OPERATOR_CONFIGURATION_CONFLICT' } })
  })
  it('returns an actionable blocked result for an absent Claude preset instead of a failed check', async () => {
    const source = { get: vi.fn(async () => { throw new DomainError('HARNESS_PROFILE_REQUIRED', 'Configure the selected harness with an actual host-local profile first.', 409) }) }
    const result = await new ExecutionReadinessService(new NativeRollout({}), source).get(principal, 'claude')
    expect(result).toMatchObject({ harness: 'claude', status: 'blocked', rolloutEnabled: true, defaultsRevision: null,
      reason: { code: 'HARNESS_PROFILE_REQUIRED', message: 'Configure the selected harness with an actual host-local profile first.' } })
  })
  it('does not convert authorization or server failures into setup evidence', async () => {
    const source = { get: vi.fn(async () => { throw new DomainError('ACCESS_DENIED', 'Denied', 403) }) }
    await expect(new ExecutionReadinessService(new NativeRollout({}), source).get(principal, 'claude')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })
  it('preserves the Claude production rollout restriction', async () => {
    expect(new NativeRollout({}).enabled('claude')).toBe(true)
    expect(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CLAUDE_SDK: '0' }).enabled('claude')).toBe(false)
    expect(new NativeRollout({ NODE_ENV: 'production', GRAPHQL_ENABLE_EXPERIMENTAL_CLAUDE_SDK: '1' }).enabled('claude')).toBe(false)
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CLAUDE_SDK: '0' }), catalog()).get(principal, 'claude')
    expect(result.reason?.message).toContain('Claude execution')
  })
  it.each(['codex'] as const)('reports explicitly disabled %s execution without probing', async (harness) => {
    const source = catalog()
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0' }), source).get(principal, harness)
    expect(result).toMatchObject({ status: 'blocked', rolloutEnabled: false, reason: { code: 'NATIVE_ROLLOUT_DISABLED' } })
    expect(source.get).not.toHaveBeenCalled()
  })
  it.each(['codex'] as const)('enables supported local %s by default and still qualifies its saved configuration', async (harness) => {
    const source = catalog()
    expect(await new ExecutionReadinessService(new NativeRollout({}), source).get(principal, harness)).toMatchObject({ status: 'eligible', rolloutEnabled: true })
    expect(source.get).toHaveBeenCalledWith(principal, harness)
  })
  it.each([{ HOST: '0.0.0.0' }, { GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: 'invalid' }, { NODE_ENV: 'production' }])('does not implicitly enable Codex for %j', (environment) => {
    expect(new NativeRollout(environment).enabled('codex')).toBe(false)
  })

  it.each(['CODEX_VERSION_UNQUALIFIED', 'CODEX_AUTH_UNAVAILABLE', 'CODEX_MODEL_UNAVAILABLE'])('reports existing qualification failure %s', async (code) => {
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog({ code, message: 'Safe diagnostic' })).get(principal, 'codex')
    expect(result).toMatchObject({ status: 'blocked', defaultsRevision: 7, reason: { code } })
  })
  it('labels inconclusive checks as unverified', async () => {
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog({ code: 'HARNESS_CHECK_TIMEOUT', message: 'Timed out' })).get(principal, 'codex')
    expect(result.status).toBe('unverified')
  })
  it('reads qualification of saved defaults and retains its revision', async () => {
    const result = await new ExecutionReadinessService(new NativeRollout({ GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog()).get(principal, 'codex')
    expect(result).toMatchObject({ status: 'eligible', scope: 'saved-harness-defaults', defaultsRevision: 7, reason: null })
  })
  it('never enables Codex in production and denies ungranted reads', async () => {
    const service = new ExecutionReadinessService(new NativeRollout({ NODE_ENV: 'production', GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }), catalog())
    expect((await service.get(principal, 'codex')).status).toBe('blocked')
    await expect(service.get({ ...principal, grants: [] }, 'codex')).rejects.toMatchObject({ status: 403 })
  })
  it.each(['codex', 'claude'] as const)(
    'qualifies local production %s through the normal admission checks', async harness => {
      const environment = { NODE_ENV: 'production', GRAPHQL_LOCAL_PRODUCTION: '1', HOST: '127.0.0.1',
        DATABASE_URL: 'postgresql://owner:password@127.0.0.1:55440/graphql_production' }
      const source = catalog({ code: 'HARNESS_PROFILE_UNAVAILABLE', message: 'Configure a host profile.' })
      const service = new ExecutionReadinessService(new NativeRollout(environment), source)
      expect(await service.get(principal, harness)).toMatchObject({ rolloutEnabled: true, status: 'blocked',
        reason: { code: 'HARNESS_PROFILE_UNAVAILABLE' } })
      expect(source.get).toHaveBeenCalledWith(principal, harness)
      await expect(service.get({ ...principal, grants: [] }, harness)).rejects.toMatchObject({ status: 403 })
      for (const override of [{ HOST: '0.0.0.0' }, { DATABASE_URL: 'postgresql://owner@remote/database' },
        { DATABASE_URL: 'invalid' }]) {
        expect(new NativeRollout({ ...environment, ...override }).enabled(harness)).toBe(false)
      }
      const flag = harness === 'codex' ? 'GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER'
        : 'GRAPHQL_ENABLE_EXPERIMENTAL_CLAUDE_SDK'
      expect(new NativeRollout({ ...environment, [flag]: '0' }).enabled(harness)).toBe(false)
    })
})
