import assert from 'node:assert/strict'
import type pg from 'pg'
import { describe, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FileReferenceService } from '../src/modules/files/references/service.js'
import { PostgresFileReferenceAuthorization, referenceFileActions } from '../src/modules/files/references/authorization.js'
import { FileReferenceAddInputSchema, FileReferenceRemoveInputSchema } from '@foreman-code/contracts/files'
import { FILE_REFERENCE_TOOL_NAMES, fileReferenceToolAvailable } from '../src/mcp/operator/tools/fileReferences.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import { toolRoles } from '../src/mcp/unified/roles.js'

function context(grants: ManagementPrincipal['grants']): OperatorRequestContext {
  return { principal: { id: 'reader', name: 'Reader', audience: 'operator', expiresAt: '9999-12-31T00:00:00.000Z', revokedAt: null, grants },
    services: { fileReferences: {} as FileReferenceService } as OperatorRequestContext['services'] }
}

describe('FIL-36 management-only reference authority and transport schemas', () => {
  it('explicitly restricts every new MCP name to the Operator role', () => {
    for (const name of FILE_REFERENCE_TOOL_NAMES) assert.deepEqual(toolRoles(name), ['operator'])
  })
  it('uses existing resource read/update grants, not chat or run permissions', () => {
    assert.deepEqual(referenceFileActions('workspace_reference', 'write'), ['workspaces:read', 'workspaces:update'])
    assert.deepEqual(referenceFileActions('workflow_reference', 'write'), ['workflows:read', 'workflows:update'])
  })
  it('lists read tools but never write tools for a read-only Operator', () => {
    const read = context([{ actions: ['workspaces:read'], scope: { workspaceIds: ['one'] } }])
    assert.equal(fileReferenceToolAvailable(read, 'reference_files_list'), true)
    assert.equal(fileReferenceToolAvailable(read, 'reference_file_read'), true)
    assert.equal(fileReferenceToolAvailable(read, 'reference_file_add'), false)
    assert.equal(fileReferenceToolAvailable(read, 'reference_file_remove'), false)
  })
  it('does not combine read and update on disjoint workspaces or workflows', () => {
    const workspaces = context([
      { actions: ['workspaces:read'], scope: { workspaceIds: ['one'] } },
      { actions: ['workspaces:update'], scope: { workspaceIds: ['two'] } },
    ])
    assert.equal(fileReferenceToolAvailable(workspaces, 'reference_file_add'), false)
    const workflows = context([
      { actions: ['workflows:read'], scope: { workspaceIds: ['one'], workflowIds: ['a'] } },
      { actions: ['workflows:update'], scope: { workspaceIds: ['one'], workflowIds: ['b'] } },
    ])
    assert.equal(fileReferenceToolAvailable(workflows, 'reference_file_remove'), false)
  })
  it('requires both grants but accepts overlapping scoped grants', () => {
    const scoped = context([
      { actions: ['workflows:read'], scope: { workspaceIds: ['one'], workflowIds: ['a', 'b'] } },
      { actions: ['workflows:update'], scope: { workspaceIds: ['one'], workflowIds: ['b'] } },
    ])
    assert.equal(fileReferenceToolAvailable(scoped, 'reference_file_add'), true)
    assert.equal(fileReferenceToolAvailable(scoped, 'reference_file_remove'), true)
    assert.equal(fileReferenceToolAvailable(context([{ actions: ['workspaces:update'], scope: {} }]), 'reference_file_add'), false)
  })
  it('does not convert run-limited or workflow-limited grants into workspace authority', () => {
    const run = context([{ actions: ['workflows:read', 'workflows:update'], scope: { runIds: ['run'] } }])
    const workspace = context([{ actions: ['workspaces:read', 'workspaces:update'], scope: { workflowIds: ['workflow'] } }])
    assert.equal(fileReferenceToolAvailable(run, 'reference_file_add'), false)
    assert.equal(fileReferenceToolAvailable(workspace, 'reference_file_add'), false)
    assert.equal(fileReferenceToolAvailable(context([{ actions: ['workspaces:read'], scope: { workspaceIds: [] } }]), 'reference_files_list'), false)
  })
  it('checks selected reference scopes without borrowing grants from siblings or Runs', () => {
    const scoped = context([
      { actions: ['workflows:read'], scope: { workspaceIds: ['one'], workflowIds: ['a', 'b'] } },
      { actions: ['workflows:update'], scope: { workspaceIds: ['one'], workflowIds: ['b'] } },
    ])
    const resource = { workspaceId: 'one', workflowId: 'b', runId: 'run' }
    assert.equal(fileReferenceToolAvailable(scoped, 'reference_file_add', resource), true)
    assert.equal(fileReferenceToolAvailable(scoped, 'reference_file_add', { ...resource, workflowId: 'a' }), false)
    assert.equal(fileReferenceToolAvailable(scoped, 'reference_file_read', { ...resource, workflowId: 'a' }), true)
    assert.equal(fileReferenceToolAvailable(scoped, 'reference_file_read', { ...resource, workspaceId: 'two' }), false)
    assert.equal(fileReferenceToolAvailable(scoped, 'reference_file_read', { workspaceId: 'one' }), false)
    const run = context([{ actions: ['workflows:read'], scope: { runIds: ['run'] } }])
    assert.equal(fileReferenceToolAvailable(run, 'reference_file_read', resource), false)
    const workspace = context([{ actions: ['workspaces:read'], scope: { workspaceIds: ['one'] } }])
    assert.equal(fileReferenceToolAvailable(workspace, 'reference_file_read', resource), true)
  })
  it('does not list capabilities for workers, revoked callers, or absent services', () => {
    const allowed = context([{ actions: ['workspaces:read', 'workspaces:update'], scope: {} }])
    assert.equal(fileReferenceToolAvailable({ ...allowed, principal: { ...allowed.principal, audience: 'worker' } }, 'reference_file_add'), false)
    assert.equal(fileReferenceToolAvailable({ ...allowed, principal: { ...allowed.principal, revokedAt: '2020-01-01T00:00:00.000Z' } }, 'reference_file_add'), false)
    assert.equal(fileReferenceToolAvailable({ ...allowed, services: {} as OperatorRequestContext['services'] }, 'reference_file_add'), false)
  })
  it('rejects worker and foreign-scope authority before reading resource metadata', async () => {
    let queried = false
    const authorization = new PostgresFileReferenceAuthorization({ query: async () => { queried = true; throw new Error('Unexpected SQL') } } as unknown as pg.Pool)
    const caller = context([{ actions: ['workspaces:read', 'workspaces:update'], scope: { workspaceIds: ['own'] } }]).principal
    for (const [principal, workspaceId] of [[caller, 'foreign'], [{ ...caller, audience: 'worker' } as ManagementPrincipal, 'own']] as const) {
      await assert.rejects(authorization.resolve(principal, { kind: 'workspace_reference', workspaceId }, 'write'), { code: 'ACCESS_DENIED' })
    }
    assert.equal(queried, false)
  })
  it('rejects overwrite targets, paths, URLs, temporary destinations and expiry fields', () => {
    const valid = { scope: { kind: 'workspace_reference', workspaceId: 'one' },
      upload: { requestId: 'new-file', filename: 'notes.md', mediaType: 'text/markdown', byteSize: 0, sha256: '0'.repeat(64) }, contentBase64: '' }
    assert.equal(FileReferenceAddInputSchema.safeParse(valid).success, true)
    for (const extra of [{ fileId: 'replace' }, { path: '/etc/passwd' }, { url: 'https://example.invalid/file' }]) {
      assert.equal(FileReferenceAddInputSchema.safeParse({ ...valid, ...extra }).success, false)
    }
    assert.equal(FileReferenceAddInputSchema.safeParse({ ...valid, scope: { ...valid.scope, expiresAt: '2099-01-01T00:00:00.000Z' } }).success, false)
    assert.equal(FileReferenceAddInputSchema.safeParse({ ...valid, upload: { ...valid.upload, filename: '../notes.md' } }).success, false)
    assert.equal(FileReferenceAddInputSchema.safeParse({ ...valid, scope: { kind: 'temporary' } }).success, false)
    assert.equal(FileReferenceRemoveInputSchema.safeParse({ commandId: 'remove-1', fileId: 'file' }).success, false)
  })
})
