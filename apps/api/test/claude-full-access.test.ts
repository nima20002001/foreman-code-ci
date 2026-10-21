import { expect, it } from 'vitest'
import { CLAUDE_QUALIFICATION_CHECKS } from '@foreman-code/contracts/claude-qualification'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { compileClaudeConfiguration, type ClaudePolicyQualification } from '../src/modules/harnesses/claudeSdk/configuration.js'

function fixture(sandbox: ClaudeHarnessConfiguration['sandbox']) {
  const configuration: ClaudeHarnessConfiguration = { harness: 'claude', model: 'fixture', authMode: 'subscription',
    configDirectory: '/fixture/profile', permissionMode: 'default', sandbox, tools: ['Read', 'Bash'],
    permissionRules: [{ tool: 'Read', effect: 'allow' }, { tool: 'Bash', effect: 'ask' }], instructions: '', mcpServers: {} }
  const target = { hostRef: { kind: 'main' as const, mainId: '11111111-1111-4111-8111-111111111111' },
    applicationInstallationId: '11111111-1111-4111-8111-111111111111', harnessInstallationId: 'fixture-cli', installationFingerprint: 'fixture-payload' }
  const pin = { sdkVersion: 'fixture-sdk', sdkIntegrity: 'fixture-integrity', cliVersion: 'fixture-cli',
    executableSha256: 'a'.repeat(64), profilePath: configuration.configDirectory, configRevision: 'fixture-revision' }
  const binding = { target, instanceId: 'fixture-instance', instanceRevision: 'fixture-revision', configurationFingerprint: 'fixture-config',
    driverId: 'claude', driverRevision: '1', protocolRevision: 'fixture-protocol', suiteRevision: 'fixture-suite',
    environmentGeneration: 'fixture-env', connectionGeneration: 'fixture-connection', pin }
  const qualification: ClaudePolicyQualification = {
    currentBinding: binding,
    override: { ...binding, revision: 1, presetId: 'fixture-preset', enabled: true, configuration, qualification: 'qualified' },
    persistedProof: { ...binding, authenticated: true, compatible: true, qualified: true, checkedAt: '2026-10-02T00:00:00.000Z',
      claudeProof: { pin, observedTools: configuration.tools, checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map((check) => [check,
        { state: 'passed' as const, source: 'native_scenario' as const, evidenceId: `synthetic:${check}`, evidenceSha256: 'b'.repeat(64) }])) } },
  }
  return { configuration, qualification }
}

it('compiles explicit full access with the native sandbox disabled and app approvals retained', () => {
  const f = fixture('danger-full-access')
  const compiled = compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})
  expect(compiled.sandbox).toEqual({ enabled: false, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false })
  expect(compiled.permissionMode).toBe('default')
  expect(compiled.allowedTools).toEqual(['Read'])
  expect(compiled.tools).toEqual(['Read', 'Bash'])
  expect(compiled.configuration.permissionRules).toContainEqual({ tool: 'Bash', effect: 'ask' })
})

it('requires native full-access policy evidence and exact saved configuration identity', () => {
  const f = fixture('danger-full-access')
  delete f.qualification.persistedProof.claudeProof!.checks.fullAccessPolicy
  expect(() => compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})).toThrow('not proved')
  const restricted = fixture('read-only')
  expect(() => compileClaudeConfiguration({ ...restricted.configuration, sandbox: 'danger-full-access' }, '/fixture/work', restricted.qualification, {})).toThrow('differs')
})

it.each(['read-only', 'workspace-write'] as const)('rejects %s instead of changing the accepted access mode', sandbox => {
  const f = fixture(sandbox)
  expect(() => compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})).toThrow(/Claude requires Full access/)
  expect(f.configuration.sandbox).toBe(sandbox)
})

it('qualifies built-ins separately from MCP names and preserves explicit MCP automatic approvals', () => {
  const f = fixture('danger-full-access')
  f.configuration.tools.push('mcp__graphql__workspace_list')
  f.configuration.permissionRules.push({ tool: 'mcp__graphql__workspace_list', effect: 'allow' })
  f.qualification.persistedProof.claudeProof!.observedTools = ['Read', 'Bash']
  const compiled = compileClaudeConfiguration(f.configuration, '/fixture/work', f.qualification, {})
  expect(compiled.tools).toEqual(['Read', 'Bash'])
  expect(compiled.allowedTools).toEqual(['Read', 'mcp__graphql__workspace_list'])
})
