import { expect, it, vi } from 'vitest'
import { CLAUDE_QUALIFICATION_CHECKS } from '@foreman-code/contracts/claude-qualification'
import type { AcceptedClaudeProfile } from '../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import { inspectClaudeOperatorConfiguration } from '../src/modules/harnesses/claudeSdk/operatorConfigurationInspection.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import type { ClaudeSdkClient } from '../src/modules/harnesses/claudeSdk/port.js'

const endpoint = 'http://127.0.0.1:3050/mcp'
function fixture(observedEndpoint = endpoint, serverName = 'graphql') {
  const configuration = { harness: 'claude' as const, model: 'unit-model', effort: 'medium' as const, authMode: 'subscription' as const,
    configDirectory: '/unit/profile', sandbox: 'danger-full-access' as const, permissionMode: 'default' as const,
    tools: ['Write'], permissionRules: [], instructions: '', mcpServers: { [serverName]: { type: 'http' as const, url: endpoint } } }
  const target = { hostRef: { kind: 'main' as const, mainId: '00000000-0000-4000-8000-000000000001' }, applicationInstallationId: '00000000-0000-4000-8000-000000000001', harnessInstallationId: 'unit-installation', installationFingerprint: 'unit-fingerprint' }
  const override = { instanceId: '00000000-0000-4000-8000-000000000002', instanceRevision: '1', revision: 1,
    target, presetId: 'unit', driverId: 'claude', enabled: true, configuration, configurationFingerprint: 'unit-config', qualification: 'qualified' as const }
  const pin = { sdkVersion: '0.3.284', sdkIntegrity: 'unit-integrity', cliVersion: '2.1.284', executableSha256: 'a'.repeat(64), profilePath: configuration.configDirectory, configRevision: '1' }
  const fields = { target, instanceRevision: '1', configurationFingerprint: 'unit-config', driverId: 'claude', driverRevision: '1',
    protocolRevision: 'unit-protocol', suiteRevision: 'claude-profile-check-v1', environmentGeneration: 'unit-env', connectionGeneration: 'unit-connection' }
  const accepted: AcceptedClaudeProfile = { override, currentBinding: { ...fields, instanceId: override.instanceId, pin },
    persistedProof: { ...fields, authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString(), claudeProof: {
      pin, observedTools: ['Write'], checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map(check => [check,
        { state: 'passed' as const, source: 'native_scenario' as const, evidenceId: `synthetic-unit:${check}`, evidenceSha256: 'b'.repeat(64) }])) } } }
  const frames = new ClaudeBoundedQueue<unknown>(2), messages = vi.fn(), close = vi.fn(() => frames.close()), joinClosed = vi.fn(async () => {})
  const status = vi.fn(async () => [{ name: serverName, status: 'needs-auth', config: { type: 'http', url: observedEndpoint } }])
  const query = vi.fn<ClaudeSdkClient['query']>(input => {
    void (async () => { for await (const message of input.prompt) messages(message) })()
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close, joinClosed, interrupt: async () => {},
      initializationResult: async () => ({}), mcpServerStatus: status }
  })
  const sdk: ClaudeSdkClient = { sdkVersion: '0.3.284', query, getSessionInfo: async () => undefined, getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'forbidden' }) }
  const revalidate = vi.fn(async () => {})
  return { query, messages, close, joinClosed, status, input: { accepted, binary: '/unit/claude', workingDirectory: '/unit/work', endpoint,
    recovery: { root: '/unit/recovery', owner: 'unit-read-inspection' }, signal: AbortSignal.timeout(1000), revalidate, loadClient: async () => sdk } }
}

it.each(['graphql', 'foreman-code'])('observes %s HTTP config with zero input, no credential, deny-all callbacks and joined closure', async (serverName) => {
  const f = fixture(endpoint, serverName)
  expect(await inspectClaudeOperatorConfiguration(f.input)).toMatchObject({ harness: 'claude', status: 'configured', endpoint, routing: 'fixed' })
  expect(f.messages).not.toHaveBeenCalled(); expect(f.status).toHaveBeenCalledOnce()
  expect(f.query.mock.calls[0]![0].options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true,
    mcpServers: { [serverName]: { type: 'http', url: endpoint } } })
  expect(f.close).toHaveBeenCalledOnce(); expect(f.joinClosed).toHaveBeenCalledOnce()
  expect(f.input.revalidate).toHaveBeenCalledTimes(2)
})

it('does not label saved JSON configured when the actual native endpoint differs', async () => {
  const f = fixture('http://127.0.0.1:3050/wrong')
  expect(await inspectClaudeOperatorConfiguration(f.input)).toMatchObject({ status: 'setup_required' })
  expect(f.messages).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalled()
})
