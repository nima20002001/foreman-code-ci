import { expect, it } from 'vitest'
import { CLAUDE_FULL_ACCESS_REQUIRED, ClaudeHarnessConfigurationSchema } from './claude.js'
import { DEFAULT_HARNESS_DEFAULTS, SupportedHarnessConfigurationSchema, HarnessWorkflowCompatibilitySchema } from './index.js'
import { AgentCreateInputSchema, HarnessDefaultsUpdateInputSchema } from './management/index.js'
import { HostHarnessOverrideSaveSchema } from './harnessRegistry.js'

const configuration = { harness: 'claude' as const, model: 'fixture', authMode: 'subscription' as const,
  configDirectory: '/fixture/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
  tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }

it.each(['read-only', 'workspace-write', 'another-mode'])('rejects %s without changing the supplied configuration', sandbox => {
  const value = { ...configuration, sandbox }
  const result = SupportedHarnessConfigurationSchema.safeParse(value)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('Unsupported access mode was accepted')
  expect(result.error.issues.some(issue => issue.message === CLAUDE_FULL_ACCESS_REQUIRED)).toBe(true)
  expect(value.sandbox).toBe(sandbox)
})

it('allows Full access and keeps an unsupported stored value readable for explicit correction', () => {
  expect(SupportedHarnessConfigurationSchema.parse(configuration)).toEqual(configuration)
  expect(ClaudeHarnessConfigurationSchema.parse({ ...configuration, sandbox: 'read-only' }).sandbox).toBe('read-only')
})

it('uses the same Full access validation in agent saves, host saves, preset saves and workflow compatibility', () => {
  const unsupported = { ...configuration, sandbox: 'read-only' }
  const mainId = '11111111-1111-4111-8111-111111111111'
  const commandId = '22222222-2222-4222-8222-222222222222'
  const inputs = [
    AgentCreateInputSchema.safeParse({ workspaceId: 'workspace', agentId: 'agent', commandId,
      name: 'Claude', configuration: unsupported, prompt: {} }),
    HostHarnessOverrideSaveSchema.safeParse({ commandId, instanceId: commandId, expectedRevision: 0,
      presetId: 'preset', enabled: true, configuration: unsupported, target: {
        hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        harnessInstallationId: 'installed-sdk', installationFingerprint: 'installed-payload',
      } }),
    HarnessWorkflowCompatibilitySchema.safeParse({ configuration: unsupported, workflowApprovalHandler: 'user' }),
  ]
  for (const result of inputs) {
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Unsupported configuration was accepted')
    expect(result.error.issues.some(issue => issue.message === CLAUDE_FULL_ACCESS_REQUIRED)).toBe(true)
  }
  expect(HarnessDefaultsUpdateInputSchema.safeParse({ commandId, expectedRevision: 0, configure: ['claude'],
    defaults: { ...DEFAULT_HARNESS_DEFAULTS, claude: unsupported } }).success).toBe(false)
})

it('rejects external MCP servers on configuration writes while preserving stored readback', () => {
  const external = { ...configuration, tools: ['mcp__external__lookup'],
    permissionRules: [{ tool: 'mcp__external__lookup', effect: 'allow' }],
    mcpServers: { external: { type: 'http', url: 'https://external.example/mcp' } } }
  expect(ClaudeHarnessConfigurationSchema.parse(external)).toEqual(external)
  const result = SupportedHarnessConfigurationSchema.safeParse(external)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('Unsupported external MCP server was accepted')
  expect(result.error.issues).toContainEqual(expect.objectContaining({
    path: ['mcpServers', 'external'], message: expect.stringContaining('External MCP servers are not supported'),
  }))
  expect(HarnessDefaultsUpdateInputSchema.safeParse({ commandId: 'external-server-save', expectedRevision: 0,
    configure: ['claude'], defaults: { ...DEFAULT_HARNESS_DEFAULTS, claude: external } }).success).toBe(false)
})

it('permits retaining an incomplete Claude preset while selecting another provider', () => {
  const defaults = { ...DEFAULT_HARNESS_DEFAULTS, claude: { ...configuration, sandbox: 'read-only' } }
  expect(HarnessDefaultsUpdateInputSchema.parse({ commandId: 'other-provider-save', expectedRevision: 1,
    configure: ['codex'], defaults }).defaults).toEqual(defaults)
})

it.each(['foreman-code', 'graphql'])('accepts the supported app MCP connection named %s', name => {
  const value = { ...configuration, mcpServers: { [name]: { type: 'http', url: 'http://127.0.0.1:3050/mcp' } } }
  expect(SupportedHarnessConfigurationSchema.parse(value)).toEqual(value)
})
