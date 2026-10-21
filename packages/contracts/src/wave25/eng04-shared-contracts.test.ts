import { describe, expect, it } from 'vitest'
import { makeSharedV3Fixture } from './eng04-shared-fixture.js'
import { makeCurrentWorkflowFixture, type CurrentFixtureForm } from './currentFixture.js'
import {
  SavedWorkflowDefinitionSchema, SavedWorkflowVersionSchema, SavedWorkflowRunSchema,
  SavedRunDetailsSchema, SavedRunVersionSnapshotSchema, SavedManagedWorkflowSchema,
} from './saved.js'
import { AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema, RunStartV3InputSchema,
  RepeatStartSnapshotV1Schema, AcceptedRepeatStartV1Schema } from './repeatAdmission.js'

const forms: CurrentFixtureForm[] = ['single', 'sequential', 'parallel', 'conditional', 'approval', 'repeat']
describe('ENG04 one current saved/read/Start contract', () => {
  it.each(forms)('preserves exact V3 pins and optional repeat for %s', (form) => {
    const f = makeCurrentWorkflowFixture(`shared-${form}`, form)
    expect(SavedWorkflowDefinitionSchema.parse(f.version.definition)).toEqual(f.version.definition)
    expect(SavedWorkflowVersionSchema.parse(f.version)).toEqual(f.version)
    expect(SavedWorkflowRunSchema.parse(f.run)).toEqual(f.run)
    expect(SavedRunVersionSnapshotSchema.parse({ run: f.run, version: f.version }).version).toEqual(f.version)
    expect(SavedRunDetailsSchema.safeParse({ run: f.run, executions: [], activity: [] }).success).toBe(true)
    expect(ExecutableWorkflowV3Schema.parse({ version: f.version, configurations: f.configurations }).version).toEqual(f.version)
    expect(Object.hasOwn(f.version.definition, 'repeat')).toBe(form === 'repeat')
    expect(Object.hasOwn(f.run, 'repeat')).toBe(false)
  })
  it.each([0, 1, 2, 4, '3', null])('rejects retired or unknown saved semantics tag %s', (tag) => {
    const f = makeCurrentWorkflowFixture('shared-denied')
    expect(SavedWorkflowVersionSchema.safeParse({ ...f.version, executionSemanticsVersion: tag }).success).toBe(false)
    expect(SavedWorkflowDefinitionSchema.safeParse({ ...f.version.definition, executionSemanticsVersion: tag }).success).toBe(false)
    expect(SavedWorkflowRunSchema.safeParse({ ...f.run, executionSemanticsVersion: tag }).success).toBe(false)
  })
  it('keeps immutable Run/version/configuration and private admission pins', () => {
    const f = makeSharedV3Fixture()
    expect(SavedManagedWorkflowSchema.safeParse({ workflow: f.version.definition, revision: 7,
      currentVersionId: f.version.id, archivedAt: null }).success).toBe(true)
    for (const run of [
      { ...f.run, workspaceId: 'other' }, { ...f.run, workflowId: 'other' },
      { ...f.run, workflowVersionId: 'other' }, { ...f.run, agentConfigurationVersionIds: {} },
      { ...f.run, approval: undefined }, { ...f.run, executionCondition: { kind: 'manual', description: 'changed' } },
    ]) expect(SavedRunVersionSnapshotSchema.safeParse({ run, version: f.version }).success).toBe(false)
    const { executionLocation: _location, authorizationPrincipalId: _principal, ...visible } = f.run
    expect(SavedWorkflowRunSchema.safeParse(visible).success).toBe(true)
    expect(AcceptedWorkflowRunV3Schema.safeParse(visible).success).toBe(false)
    void _location; void _principal
  })
  it('rejects stale Start/location/configuration pins and fabricated terminal admission', () => {
    const f = makeSharedV3Fixture()
    for (const request of [
      { ...f.request, expectedWorkflowRevision: undefined }, { ...f.request, expectedAgentConfigurationVersionIds: undefined },
      { ...f.request, draftId: 'draft-only' }, { ...f.request, expectedDraftRevision: 1 },
      { ...f.request, executionSemanticsVersion: 2 },
    ]) expect(RunStartV3InputSchema.safeParse(request).success).toBe(false)
    for (const snapshot of [
      { ...f.snapshot, request: { ...f.request, expectedWorkflowRevision: 6 } },
      { ...f.snapshot, request: { ...f.request, expectedLocationRevision: 5 } },
      { ...f.snapshot, workflow: { ...f.snapshot.workflow, currentVersionId: 'other' } },
    ]) expect(RepeatStartSnapshotV1Schema.safeParse(snapshot).success).toBe(false)
    for (const run of [{ ...f.run, input: { changed: true } },
      { ...f.run, authorizationPrincipalId: 'other' }, { ...f.run, executionLocation: { ...f.location, rootPath: '/other' } },
      { ...f.run, executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: f.createdAt },
    ]) expect(AcceptedRepeatStartV1Schema.safeParse({ snapshot: f.snapshot, run }).success).toBe(false)
  })
})
