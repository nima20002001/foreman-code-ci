import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkspaceRepositoryAddInputSchema, WorkspaceRepositoryGetInputSchema,
  WorkspaceRepositoryReadResultSchema } from './workspaceGit.js'

const repository = { provider: 'github', owner: 'octo-owner', name: 'website', defaultBranch: 'main' }
const input = { workspaceId: 'workspace', commandId: randomUUID(), expectedRevision: 0,
  expectedLocationRevision: 0, expectedRootPolicyRevision: 0, expectedBindingRevision: 0,
  repository, allowedBaseId: randomUUID(), configurationRevision: '1' }

describe('workspace repository import contracts', () => {
  it('accepts configuration revisions and exposes an original attempt read', () => {
    expect(WorkspaceRepositoryAddInputSchema.parse(input)).toEqual(input)
    expect(WorkspaceRepositoryGetInputSchema.parse({ workspaceId: input.workspaceId, commandId: input.commandId }))
      .toEqual({ workspaceId: input.workspaceId, commandId: input.commandId })
  })

  it.each([
    'cloneCommand', 'environment', 'credential', 'url', 'absolutePath', 'replaceDirectory',
  ])('rejects caller-owned import control %s', field => {
    expect(WorkspaceRepositoryAddInputSchema.safeParse({ ...input, [field]: '/tmp/project' }).success).toBe(false)
  })

  it.each([
    'expectedRevision', 'expectedLocationRevision', 'expectedRootPolicyRevision', 'expectedBindingRevision',
  ])('rejects invalid %s', field => {
    expect(WorkspaceRepositoryAddInputSchema.safeParse({ ...input, [field]: -1 }).success).toBe(false)
    expect(WorkspaceRepositoryAddInputSchema.safeParse({ ...input, [field]: 1.5 }).success).toBe(false)
  })

  it('retains the original retry request and rejects a mismatched workspace or command', () => {
    const preparing = { workspaceId: input.workspaceId, repository, revision: 1, state: 'preparing',
      operation: { commandId: input.commandId, phase: 'metadata', retryInput: input } }
    expect(WorkspaceRepositoryReadResultSchema.parse(preparing).operation?.retryInput).toEqual(input)
    for (const retryInput of [{ ...input, workspaceId: 'another-workspace' }, { ...input, commandId: randomUUID() }]) {
      expect(WorkspaceRepositoryReadResultSchema.safeParse({ ...preparing,
        operation: { ...preparing.operation, retryInput } }).success).toBe(false)
    }
  })

  it('reports metadata and partial progress without claiming readiness', () => {
    const base = { workspaceId: 'workspace', repository, revision: 1 }
    expect(WorkspaceRepositoryReadResultSchema.parse({ ...base, state: 'metadata-only' }).state).toBe('metadata-only')
    const failed = { ...base, state: 'failed', operation: { commandId: input.commandId, phase: 'metadata',
      commit: 'a'.repeat(40), failure: { code: 'SOURCE_UNAVAILABLE', message: 'Source preparation failed.',
        retryable: false, newCommandRequired: true } } }
    expect(WorkspaceRepositoryReadResultSchema.parse(failed).operation?.failure?.newCommandRequired).toBe(true)
    expect(WorkspaceRepositoryReadResultSchema.safeParse({ ...base, state: 'ready' }).success).toBe(false)
  })
})
