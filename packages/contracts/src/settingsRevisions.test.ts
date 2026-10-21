import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from './index.js'
import { HostHarnessOverrideSaveSchema } from './harnessRegistry.js'
import { ComputerSyncUpdateInputSchema } from './computerSync.js'
import { FileRetentionSaveInputSchema } from './files.js'
import {
  ClaudePluginChangeInputSchema, ClaudePluginMarketplaceAddInputSchema,
  HarnessDefaultsUpdateInputSchema, HarnessMcpManagedInputSchema, HarnessMcpPlanInputSchema,
  HarnessMcpReconcileInputSchema, GeneralSettingsUpdateInputSchema, PromptSettingUpdateInputSchema,
  WorkspaceDefaultsUpdateInputSchema,
} from './management/index.js'

const id = randomUUID()
const commandId = randomUUID()
const target = { hostRef: { kind: 'main', mainId: id }, applicationInstallationId: id,
  harnessInstallationId: 'fixture-installation', installationFingerprint: 'fixture-fingerprint' }
const cases = [
  { name: 'host profiles', schema: HostHarnessOverrideSaveSchema, revision: 0,
    input: { commandId, instanceId: id, target, presetId: 'fixture', enabled: true,
      configuration: DEFAULT_HARNESS_DEFAULTS.codex } },
  { name: 'harness defaults', schema: HarnessDefaultsUpdateInputSchema, revision: 0,
    input: { commandId, defaults: DEFAULT_HARNESS_DEFAULTS } },
  { name: 'file retention', schema: FileRetentionSaveInputSchema, revision: 0,
    input: { commandId, durationSeconds: 3600 } },
  { name: 'computer sync', schema: ComputerSyncUpdateInputSchema, revision: 0,
    input: { commandId, workspaceId: 'fixture-workspace', enabled: false,
      target: { hostRef: target.hostRef, applicationInstallationId: id, keyRevision: null, authorizationRevision: null } } },
  { name: 'native MCP changes', schema: HarnessMcpPlanInputSchema, revision: `sha256:${'a'.repeat(64)}`,
    input: { commandId, harness: 'codex', change: { kind: 'remove', name: 'fixture' } } },
  { name: 'managed MCP changes', schema: HarnessMcpManagedInputSchema, revision: `sha256:${'a'.repeat(64)}`,
    input: { commandId, harness: 'codex', preset: 'graphql', installed: true } },
  { name: 'MCP reconciliation', schema: HarnessMcpReconcileInputSchema, revision: `sha256:${'a'.repeat(64)}`,
    input: { commandId, planId: id } },
  { name: 'Claude plugins', schema: ClaudePluginChangeInputSchema, revision: 'a'.repeat(64),
    input: { commandId, pluginId: 'notes@official', action: 'enable' } },
  { name: 'Claude marketplaces', schema: ClaudePluginMarketplaceAddInputSchema, revision: 'a'.repeat(64),
    input: { commandId, source: 'owner/official' } },
  { name: 'general preferences', schema: GeneralSettingsUpdateInputSchema, revision: 0,
    input: { commandId, value: { theme: 'light' } } },
  { name: 'prompts', schema: PromptSettingUpdateInputSchema, revision: 0,
    input: { commandId, value: { text: 'Fixture prompt' } } },
  { name: 'workspace defaults', schema: WorkspaceDefaultsUpdateInputSchema, revision: 0,
    input: { commandId, value: { suggestedName: 'Fixture', description: '' } } },
]

describe('optional settings revisions', () => {
  it.each(cases)('accepts $name without a revision and validates a supplied revision', ({ schema, input, revision }) => {
    expect(schema.safeParse(input).success).toBe(true)
    expect(schema.safeParse({ ...input, expectedRevision: revision }).success).toBe(true)
    for (const expectedRevision of [null, -1, 0.5, 'invalid']) {
      expect(schema.safeParse({ ...input, expectedRevision }).success).toBe(false)
    }
  })
})
