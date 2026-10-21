import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { CodexDiagnostics } from './codexDiagnostics.js'
import type { CodexDiagnosticOperations, CodexDiagnosticPin, CodexSessionDependencies } from './codexAppServer.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { fixtureProtocol } from '../../../test/fixtures/codex-test-helpers.js'

function fixture() {
  const writer = { root: '/recorded-registry', owner: 'conversation:recorded-chat' }
  const recovery = { ...writer, owner: 'conversation-diagnostics:recorded-chat:read-1' }
  const pin: CodexDiagnosticPin = { binary: '/installed/codex', expectedVersion: '0.154.0',
    cwd: '/approved/chat', configurationIdentity: 'accepted-configuration',
    scopedCredentialVariables: ['CUSTOM_MCP_BEARER'] }
  const qualified = { binary: pin.binary, identity: 'recorded-identity', providerVersion: '0.154.0',
    protocol: fixtureProtocol, schemaManifestSha256: 'recorded', stableSchemaGitBlob: 'recorded',
    referenceSchemaManifestSha256: 'recorded' }
  const ambient = { HOST_SETTING: 'kept', FOREMAN_CODE_MCP_TOKEN: 'main-only',
    GRAPHQL_MCP_TOKEN: 'legacy-main-only', CUSTOM_MCP_BEARER: 'chat-only' }
  const admit = vi.fn((scope: NativeProcessRecovery) => { scope.launchId = 'recorded-launch' })
  const abandon = vi.fn(async () => undefined)
  const close = vi.fn(async () => undefined)
  const qualify = vi.fn<NonNullable<CodexSessionDependencies['qualify']>>(async () => qualified)
  const qualifyModel = vi.fn<NonNullable<CodexSessionDependencies['qualifyModel']>>(async () => ({ contextWindow: null }))
  const runCommand = vi.fn<NonNullable<CodexSessionDependencies['runCommand']>>(async () => ({
    stdout: '{}', stderr: '', exitCode: 0, exitSignal: null,
  }))
  const diagnostics = new CodexDiagnostics({
    native: { mode: 'native', environment: () => ({ ...ambient }), qualify, qualifyModel, runCommand },
    createRecovery: () => recovery, admitRecovery: admit, abandonRecovery: abandon, closeRecovery: close,
  })
  return { diagnostics, writer, recovery, pin, ambient, qualify, qualifyModel, runCommand, admit, abandon, close }
}

it('owns Worker metadata reads separately and pins their binary, directory and credential-free environment', async () => {
  const f = fixture()
  try {
    await f.diagnostics.run(f.pin, async io => {
      expect(f.admit).toHaveBeenCalledExactlyOnceWith(f.recovery)
      expect(io.environment()).toEqual({ HOST_SETTING: 'kept' })
      const qualified = await io.qualify('/different-codex', '/different-directory',
        { CUSTOM_MCP_BEARER: 'injected' }, true)
      await io.qualifyModel(DEFAULT_HARNESS_DEFAULTS.codex, '/different-codex', '/different-directory',
        { FOREMAN_CODE_MCP_TOKEN: 'injected' }, undefined, f.writer, { qualified })
      await io.runCommand('/different-codex', ['mcp', 'list', '--json'], '/different-directory',
        undefined, { GRAPHQL_MCP_TOKEN: 'injected' }, { recovery: f.writer })
    }, f.writer)
    expect(f.qualify).toHaveBeenCalledWith(f.pin.binary, f.pin.cwd,
      { HOST_SETTING: 'kept' }, true, expect.any(AbortSignal), f.recovery)
    expect(f.qualifyModel).toHaveBeenCalledWith(DEFAULT_HARNESS_DEFAULTS.codex, f.pin.binary, f.pin.cwd,
      { HOST_SETTING: 'kept' }, expect.any(AbortSignal), f.recovery,
      expect.objectContaining({ assertUnchanged: expect.any(Function) }))
    expect(f.runCommand).toHaveBeenCalledWith(f.pin.binary, ['mcp', 'list', '--json'], f.pin.cwd,
      expect.any(AbortSignal), { HOST_SETTING: 'kept' }, { recovery: f.recovery })
    expect(f.abandon).toHaveBeenCalledExactlyOnceWith(f.recovery)
    expect(f.close).toHaveBeenCalledExactlyOnceWith(f.recovery)
    expect(f.writer).toEqual({ root: '/recorded-registry', owner: 'conversation:recorded-chat' })
    expect(f.ambient.CUSTOM_MCP_BEARER).toBe('chat-only')
  } finally { await f.diagnostics.dispose() }
})

it('refuses writes and expires its read capability after cleanup', async () => {
  const f = fixture()
  let retained: CodexDiagnosticOperations | undefined
  try {
    await f.diagnostics.run(f.pin, async io => {
      retained = io
      await expect(io.runCommand(f.pin.binary, ['mcp', 'add', 'other'], f.pin.cwd))
        .rejects.toMatchObject({ code: 'CODEX_DIAGNOSTIC_COMMAND_DENIED' })
      await expect(io.runCommand(f.pin.binary, ['exec', 'a prompt'], f.pin.cwd))
        .rejects.toMatchObject({ code: 'CODEX_DIAGNOSTIC_COMMAND_DENIED' })
    }, f.writer)
    expect(f.runCommand).not.toHaveBeenCalled()
    expect(() => retained!.runCommand(f.pin.binary, ['mcp', 'list', '--json'], f.pin.cwd))
      .toThrow(expect.objectContaining({ code: 'CODEX_DIAGNOSTIC_CLOSED' }))
    expect(f.close).toHaveBeenCalledExactlyOnceWith(f.recovery)
  } finally { await f.diagnostics.dispose() }
})

it('closes an admitted diagnostic owner that has no reserved launch', async () => {
  const f = fixture()
  f.admit.mockImplementation(() => undefined)
  f.abandon.mockImplementation(async () => { throw new Error('Invalid native launch abandonment scope.') })
  try {
    expect(await f.diagnostics.run(f.pin, async () => 'metadata', f.writer)).toBe('metadata')
    expect(f.abandon).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledExactlyOnceWith(f.recovery)
  } finally { await f.diagnostics.dispose() }
})

it('returns failed reservation admission without starting IO or requesting nonexistent closure', async () => {
  const f = fixture()
  const failure = new Error('Reservation storage is full.')
  f.admit.mockImplementation(() => { throw failure })
  f.close.mockImplementation(async () => { throw new Error('No process closure exists.') })
  const work = vi.fn(async (io: CodexDiagnosticOperations) => io.qualify(f.pin.binary, f.pin.cwd, {}, true))
  await expect(f.diagnostics.run(f.pin, work, f.writer)).rejects.toBe(failure)
  await f.diagnostics.dispose()
  expect(work).not.toHaveBeenCalled()
  expect(f.qualify).not.toHaveBeenCalled()
  expect(f.abandon).not.toHaveBeenCalled()
  expect(f.close).not.toHaveBeenCalled()
})

it('still closes a reservation assigned before diagnostic admission throws', async () => {
  const f = fixture()
  const failure = new Error('Admission failed after reserving.')
  f.admit.mockImplementation(scope => { scope.launchId = 'recorded-launch'; throw failure })
  await expect(f.diagnostics.run(f.pin, async () => 'unused', f.writer)).rejects.toBe(failure)
  expect(f.abandon).toHaveBeenCalledExactlyOnceWith(f.recovery)
  expect(f.close).toHaveBeenCalledExactlyOnceWith(f.recovery)
  await f.diagnostics.dispose()
})
