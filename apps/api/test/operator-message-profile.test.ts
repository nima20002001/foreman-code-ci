import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, type OperatorConfigurationVersion } from '@foreman-code/contracts'
import { acceptOperatorConfiguration } from '../src/modules/conversations/operatorAcceptedConfiguration.js'

function fixture() {
  const mainId = randomUUID()
  const selector = { instanceId: randomUUID(), instanceRevision: '1', target: { hostRef: { kind: 'main' as const, mainId },
    applicationInstallationId: mainId, harnessInstallationId: 'unit-claude', installationFingerprint: 'unit-installation' } }
  const harness = { harness: 'claude' as const, model: 'unit-model', effort: 'medium' as const, authMode: 'subscription' as const,
    configDirectory: '/unit/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
    tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  const current: OperatorConfigurationVersion = { id: 'old-source', operatorId: 'application-operator', version: 1,
    harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'sha256:unit-source', createdAt: '2026-10-02T00:00:00Z' }
  const published: OperatorConfigurationVersion = { ...current, id: 'saved-claude-default', version: 2, harness, harnessProfileSelection: selector }
  const inserted: OperatorConfigurationVersion[] = []
  const query = { query: vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.includes('insert into operator_configuration_versions')) inserted.push(JSON.parse(String(args![3])))
    return { rows: sql.includes('from application_settings') ? [{ revision: 5, record: { ...DEFAULT_AGENT_DEFAULTS,
      operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness, harnessProfileSelection: selector } } }]
      : sql.includes('join operator_configuration_versions') ? [{ record: published }]
      : sql.includes('max(version)') ? [{ version: 3 }] : [] }
  }) } as unknown as pg.PoolClient
  const input = { requestId: 'unit-request', content: 'Unit content.', configurationVersionId: current.id,
    defaultsRevision: 5, settings: operatorChatSettings(harness) }
  return { current, published, harness, selector, inserted, query, input }
}

it('uses the reviewed full saved default for a different harness rather than copying the source profile', async () => {
  const f = fixture()
  f.current.harnessProfileSelection = { ...f.selector, instanceId: randomUUID() }
  const validate = vi.fn()
  expect(await acceptOperatorConfiguration(f.query, f.current, f.input, undefined, f.harness, validate)).toEqual(f.published)
  expect(validate).toHaveBeenCalledWith(f.published)
  expect(f.inserted).toEqual([])
})

it('retains the exact saved Claude profile when only thinking visibility changes', async () => {
  const f = fixture()
  const accepted = await acceptOperatorConfiguration(f.query, f.current, { ...f.input, settings: { ...f.input.settings, showThinking: true } }, undefined, f.harness)
  expect(accepted).toMatchObject({ harness: f.harness, harnessProfileSelection: f.selector, showThinking: true })
  expect(f.inserted).toEqual([accepted])
})

it('rejects changed model or sandbox under the old exact profile before any configuration write', async () => {
  for (const change of [{ model: 'different-model' }, { sandbox: 'read-only' as const }]) {
    const f = fixture()
    await expect(acceptOperatorConfiguration(f.query, f.current, f.input, undefined, { ...f.harness, ...change }))
      .rejects.toMatchObject({ code: 'HARNESS_PROFILE_SELECTION_CONFLICT' })
    expect(f.inserted).toEqual([])
  }
})

it('requires the original source pin and reviewed default revision', async () => {
  for (const change of [{ configurationVersionId: 'foreign-source' }, { defaultsRevision: 4 }]) {
    const f = fixture()
    await expect(acceptOperatorConfiguration(f.query, f.current, { ...f.input, ...change }, undefined, f.harness))
      .rejects.toMatchObject({ code: 'CONVERSATION_REVISION_CONFLICT' })
    expect(f.inserted).toEqual([])
  }
})
