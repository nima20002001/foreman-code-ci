import { randomUUID } from 'node:crypto'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import {
  WorkspaceRepositoryAddResultSchema, WorkspaceRepositoryReadResultSchema, type WorkspaceRepositoryAddInput,
} from '@foreman-code/contracts/workspace-git'
import { callWorkspaceTool } from './workspaceMcp.js'
import { fixtureRepository, workspaceRepositoryFixture } from './workspaceRepository.js'

type Fixture = Awaited<ReturnType<typeof workspaceRepositoryFixture>>

export async function workspace(f: Fixture): Promise<WorkspaceRepositoryAddInput> {
  const created = await callWorkspaceTool(f.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema,
    { commandId: randomUUID(), name: 'Git project' })
  return { workspaceId: created.value.workspace.id, commandId: randomUUID(), expectedRevision: created.value.revision,
    expectedLocationRevision: created.value.locationRevision, expectedRootPolicyRevision: 0, expectedBindingRevision: 0,
    repository: fixtureRepository, allowedBaseId: f.allowlist.bases[0]!.baseId,
    configurationRevision: f.allowlist.configurationRevision }
}

export async function httpAdd(f: Fixture, input: WorkspaceRepositoryAddInput, token = f.owner.token) {
  return fetch(new URL(`/api/management/workspaces/${input.workspaceId}/repository`, f.address), {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export const add = (f: Fixture, input: WorkspaceRepositoryAddInput) =>
  callWorkspaceTool(f.owner.client, 'workspace_repository_add', WorkspaceRepositoryAddResultSchema, input)
export const get = (f: Fixture, input: { workspaceId: string; commandId?: string }) =>
  callWorkspaceTool(f.owner.client, 'workspace_repository_get', WorkspaceRepositoryReadResultSchema, input)
export const clones = (f: Fixture) => f.gitCalls.filter(args => args.includes('clone')).length
