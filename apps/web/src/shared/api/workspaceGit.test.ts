import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { worktreeFixture } from '../../features/workflow-board/worktree.fixtures'
import { addWorkspaceRepository, readWorkspaceRepository } from './workspaceGit'
import { readWorktreeRoot } from './worktreeChoices'

describe('workspace project client boundaries', () => {
  it('encodes the original command and rejects a readback from another import', async () => {
    const project = worktreeFixture()
    const reads: string[] = []
    server.use(http.get('/api/management/workspaces/workspace-1/repository', ({ request }) => {
      reads.push(new URL(request.url).searchParams.get('commandId')!)
      return HttpResponse.json(project.ready)
    }))
    await expect(readWorkspaceRepository({ workspaceId: 'workspace-1', commandId: 'original/command' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(reads).toEqual(['original/command'])
  })

  it('accepts an authorized read with no matching import while keeping Add acknowledgements strict', async () => {
    const project = worktreeFixture()
    server.use(
      http.get('/api/management/workspaces/workspace-1/repository', () => HttpResponse.json({
        workspaceId: 'workspace-1', state: 'metadata-only', repository: project.repository, revision: 1,
      })),
      http.post('/api/management/workspaces/workspace-1/repository/add', () => HttpResponse.json({
        value: { workspaceId: 'workspace-1', state: 'preparing', repository: project.repository, revision: 1 },
        replayed: false,
      })),
    )
    await expect(readWorkspaceRepository({ workspaceId: 'workspace-1', commandId: 'original-command' }))
      .resolves.toMatchObject({ state: 'metadata-only' })
    await expect(addWorkspaceRepository({ workspaceId: 'workspace-1', commandId: 'original-command',
      expectedRevision: 1, expectedLocationRevision: 0, expectedRootPolicyRevision: 0, expectedBindingRevision: 0,
      repository: project.repository, allowedBaseId: project.selection.allowedBaseId, configurationRevision: '1' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects an Add acknowledgement for another workspace instead of claiming preparation succeeded', async () => {
    const project = worktreeFixture('other-workspace')
    server.use(http.post('/api/management/workspaces/workspace-1/repository/add', () => HttpResponse.json({
      value: project.ready, replayed: false,
    })))
    await expect(addWorkspaceRepository({ workspaceId: 'workspace-1', commandId: 'original-command',
      expectedRevision: 1, expectedLocationRevision: 0, expectedRootPolicyRevision: 0, expectedBindingRevision: 0,
      repository: project.repository, allowedBaseId: project.selection.allowedBaseId, configurationRevision: '1' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('requires the saved root revision in authorized readback', async () => {
    const project = worktreeFixture()
    server.use(http.post('/api/management/workspaces/workspace-1/source-roots/get', () => HttpResponse.json(project.root)))
    await expect(readWorktreeRoot('workspace-1', { ...project.rootBinding, bindingRevision: 2 }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
