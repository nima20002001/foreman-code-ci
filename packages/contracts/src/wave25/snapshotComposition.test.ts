import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '../index.js'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import {
  assertSavedRunVersionSnapshot, SavedRunVersionSnapshotSchema,
  SavedWorkflowRunSchema, SavedWorkflowVersionSchema,
} from './saved.js'
import { assertExecutableWorkflow } from './repeat.js'
import { ExecutableWorkflowV3Schema } from './repeatAdmission.js'

function fixture(form: 'sequential' | 'approval' | 'repeat' = 'sequential') {
  const source = makeCurrentWorkflowFixture(`snapshot-composition-${form}`, form)
  return {
    run: SavedWorkflowRunSchema.parse(source.run),
    version: SavedWorkflowVersionSchema.parse(source.version),
    configurations: source.configurations.map(configuration => AgentConfigurationVersionSchema.parse(configuration)),
  }
}

describe('parsed workflow snapshot composition', () => {
  it.each(['sequential', 'approval', 'repeat'] as const)('accepts parsed %s records', (form) => {
    const snapshot = fixture(form)
    expect(() => assertSavedRunVersionSnapshot(snapshot)).not.toThrow()
    expect(() => assertExecutableWorkflow(snapshot)).not.toThrow()
    expect(SavedRunVersionSnapshotSchema.parse({ run: snapshot.run, version: snapshot.version })).toEqual({
      run: snapshot.run,
      version: snapshot.version,
    })
    expect(ExecutableWorkflowV3Schema.parse({
      version: snapshot.version,
      configurations: snapshot.configurations,
    })).toEqual({ version: snapshot.version, configurations: snapshot.configurations })
  })

  it('rejects mismatched Run scope, configuration, approval and execution condition pins', () => {
    const { run, version } = fixture()
    const changedRuns = [
      { ...run, workspaceId: 'different-workspace' },
      { ...run, workflowId: 'different-workflow' },
      { ...run, workflowVersionId: 'different-version' },
      { ...run, agentConfigurationVersionIds: {} },
      { ...run, approval: { handler: 'native' as const } },
      { ...run, executionCondition: { kind: 'on_event' as const } },
    ]
    for (const changed of changedRuns) {
      const snapshot = { run: SavedWorkflowRunSchema.parse(changed), version }
      expect(() => assertSavedRunVersionSnapshot(snapshot)).toThrow('RUN_VERSION_SNAPSHOT_PIN_MISMATCH')
      expect(SavedRunVersionSnapshotSchema.safeParse(snapshot).success).toBe(false)
    }
  })

  it('retains configuration identity, role and native approval compatibility checks', () => {
    const { version, configurations } = fixture()
    const changedConfigurations = [
      [],
      [configurations[0]!, configurations[0]!],
      configurations.map(configuration => ({ ...configuration, workspaceId: 'different-workspace' })),
      configurations.map((configuration, index) => index
        ? { ...configuration, productRole: 'orchestrator' as const }
        : configuration),
    ]
    for (const changed of changedConfigurations) {
      const snapshot = {
        version,
        configurations: changed.map(configuration => AgentConfigurationVersionSchema.parse(configuration)),
      }
      expect(() => assertExecutableWorkflow(snapshot)).toThrow()
      expect(ExecutableWorkflowV3Schema.safeParse(snapshot).success).toBe(false)
    }

    const nativeVersion = SavedWorkflowVersionSchema.parse({
      ...version,
      approval: { handler: 'native' },
      definition: { ...version.definition, approval: { handler: 'native' } },
    })
    const defaults = configurations.map(configuration => AgentConfigurationVersionSchema.parse({
      ...configuration,
      harness: { ...configuration.harness, advanced: DEFAULT_CODEX_ADVANCED_CONFIGURATION },
    }))
    expect(ExecutableWorkflowV3Schema.safeParse({ version: nativeVersion, configurations: defaults }).success).toBe(true)
    expect(() => assertExecutableWorkflow({ version: nativeVersion, configurations: defaults })).not.toThrow()
    const incompatible = configurations.map(configuration => AgentConfigurationVersionSchema.parse({
      ...configuration,
      harness: { ...configuration.harness, advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
        approvalPolicy: 'on-request', approvalsReviewer: 'user' } },
    }))
    const snapshot = { version: nativeVersion, configurations: incompatible }
    expect(() => assertExecutableWorkflow(snapshot))
      .toThrow('pinned native configuration conflicts with approval authority')
    expect(ExecutableWorkflowV3Schema.safeParse(snapshot).success).toBe(false)
  })
})
