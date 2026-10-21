import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessQualificationSchema } from '@foreman-code/contracts'
import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../src/modules/errors.js'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'
import type { ClaudeNativeConfigurationPort } from '../src/modules/harnesses/claudeSdk/nativeConfiguration.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import * as nativeProcess from '../src/modules/harnesses/process.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { OperatorWorkspaceControls } from '../src/modules/workspaces/operatorControls.js'

const configuration = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'observed-model', authMode: 'subscription',
  configDirectory: '/selected-profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'],
  permissionRules: [], instructions: '', mcpServers: {} })
const qualification = HarnessQualificationSchema.parse({ harness: 'claude', version: '2.1.117', authenticated: true,
  ready: false, structuredEvents: false, supportsResume: false, supportsCancellation: false,
  supportsWorkingDirectory: true, supportsStartupPrompt: true, supportedNativeTools: ['Read'],
  supportedSettings: ['model'], unsupportedCapabilities: ['Native execution is unqualified'] })

afterEach(() => vi.restoreAllMocks())

describe('selected Claude native metadata producer', () => {
  function fixture(port?: ClaudeNativeConfigurationPort) {
    const factories = new NativeHarnessFactories({ codexBinary: 'unused-codex',  })
    const allocate = vi.spyOn(factories, 'allocate')
    const command = vi.spyOn(nativeProcess, 'runCommand').mockImplementation(async () => {
      throw new Error('No native command may run')
    })
    return { allocate, command, service: new NativeConfigurationService('unused-codex', '/selected-workspace', factories, port) }
  }

  it('requires actual selected-profile discovery instead of falling through to another provider', async () => {
    const f = fixture()
    try {
      await expect(f.service.options('claude')).rejects.toMatchObject({ code: 'CLAUDE_PROFILE_SELECTION_REQUIRED', status: 409 })
      await expect(f.service.refreshOptions('claude', 'catalog')).rejects.toMatchObject({ code: 'CLAUDE_PROFILE_SELECTION_REQUIRED' })
      await expect(f.service.qualifyConfiguration(configuration)).rejects.toMatchObject({ code: 'CLAUDE_PROFILE_SELECTION_REQUIRED' })
      expect(f.allocate).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled()
    } finally { await f.service.shutdownChecks() }
  })

  it('returns only injected observations and rechecks current-host metadata on every read', async () => {
    const discover = vi.fn<ClaudeNativeConfigurationPort['discover']>()
      .mockResolvedValueOnce({ providerVersion: '2.1.117', authenticated: true, nativeAgents: [],
        models: [{ id: 'observed-model', reasoningEfforts: [], variants: [], serviceTiers: [] }] })
      .mockResolvedValueOnce({ providerVersion: '2.1.118', authenticated: false, nativeAgents: [], models: [] })
    const qualify = vi.fn<ClaudeNativeConfigurationPort['qualify']>()
    const f = fixture({ discover, qualify })
    try {
      const first = await f.service.options('claude'), current = await f.service.options('claude')
      expect(first).toMatchObject({ harness: 'claude', providerVersion: '2.1.117', models: [{ id: 'observed-model' }] })
      expect(current).toMatchObject({ harness: 'claude', providerVersion: '2.1.118', authenticated: false, models: [] })
      expect(discover).toHaveBeenCalledTimes(2)
      expect(discover).toHaveBeenLastCalledWith('/selected-workspace', expect.any(AbortSignal))
      expect(current.settings.find(field => field.field === 'sandbox')?.support).toBe('supported')
      expect(qualify).not.toHaveBeenCalled(); expect(f.allocate).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled()
    } finally { await f.service.shutdownChecks() }
  })

  it('rechecks exact configuration/current-host qualification and preserves a stale-host denial', async () => {
    const qualify = vi.fn<ClaudeNativeConfigurationPort['qualify']>().mockResolvedValueOnce(qualification)
      .mockRejectedValueOnce(new DomainError('CLAUDE_PROFILE_STALE', 'Selected host profile changed.', 409))
    const discover = vi.fn<ClaudeNativeConfigurationPort['discover']>()
    const f = fixture({ discover, qualify })
    try {
      expect(await f.service.qualifyConfiguration(configuration)).toEqual(qualification)
      await expect(f.service.qualifyConfiguration(configuration)).rejects.toMatchObject({ code: 'CLAUDE_PROFILE_STALE', status: 409 })
      expect(qualify).toHaveBeenCalledTimes(2)
      expect(qualify).toHaveBeenLastCalledWith(configuration, '/selected-workspace', expect.any(AbortSignal))
      expect(discover).not.toHaveBeenCalled(); expect(f.allocate).not.toHaveBeenCalled()
    } finally { await f.service.shutdownChecks() }
  })

  it('refuses another harness qualification and unsupported upstream refresh before commands', async () => {
    const qualify = vi.fn<ClaudeNativeConfigurationPort['qualify']>().mockResolvedValue({ ...qualification, harness: 'codex' })
    const discover = vi.fn<ClaudeNativeConfigurationPort['discover']>()
    const f = fixture({ discover, qualify })
    try {
      await expect(f.service.qualifyConfiguration(configuration)).rejects.toMatchObject({ code: 'CLAUDE_QUALIFICATION_MISMATCH' })
      await expect(f.service.refreshOptions('claude', 'upstream')).rejects.toMatchObject({ code: 'CLAUDE_MODEL_REFRESH_UNSUPPORTED', status: 422 })
      expect(discover).not.toHaveBeenCalled(); expect(f.allocate).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled()
    } finally { await f.service.shutdownChecks() }
  })
})

describe('workspace diagnostics exact-profile boundary', () => {
  it('checks current workspace grants before refusing selector-free Claude diagnostics; other drivers retain their path', async () => {
    const pool = new pg.Pool()
    const connect = vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Reached existing workspace snapshot') })
    const commands = new PostgresCommandCoordinator(pool)
    const locations = new WorkspaceLocationService(pool, commands)
    const inspect = vi.fn<McpDetectionService['inspect']>()
    const detection = new McpDetectionService({ inspect: async () => { throw new Error('No native inspection may run') } }, 'http://127.0.0.1:3000/mcp')
    vi.spyOn(detection, 'inspect').mockImplementation(inspect)
    const controls = new OperatorWorkspaceControls(pool, commands, locations, detection)
    const owner: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null,
      expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['harnesses:read', 'workspace_locations:read'], scope: { workspaceIds: ['workspace'] } }] }
    try {
      const denied: ManagementPrincipal = { ...owner, grants: [{ actions: ['harnesses:read'], scope: { workspaceIds: ['workspace'] } }] }
      await expect(controls.diagnostics(denied, { workspaceId: 'workspace', harness: 'claude' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await expect(controls.diagnostics(owner, { workspaceId: 'other-workspace', harness: 'claude' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      await expect(controls.diagnostics(owner, { workspaceId: 'workspace', harness: 'claude' })).rejects.toMatchObject({ code: 'CLAUDE_PROFILE_SELECTION_REQUIRED', status: 409 })
      expect(connect).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
      for (const harness of ['codex'] as const) await expect(controls.diagnostics(owner, { workspaceId: 'workspace', harness })).rejects.toThrow('Reached existing workspace snapshot')
      expect(connect).toHaveBeenCalledTimes(1); expect(inspect).not.toHaveBeenCalled()
    } finally { await pool.end() }
  })
})
