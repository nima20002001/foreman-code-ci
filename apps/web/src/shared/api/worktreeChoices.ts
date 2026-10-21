import { useQuery } from '@tanstack/react-query'
import {
  ApprovedSourceSchema, SourceRootListResultSchema, SourceRootRecordSchema, type SourceRootRecord,
} from '@foreman-code/contracts/source-admission'
import type { SourceRootReference } from '@foreman-code/contracts/worktree-settings'
import { WorkspaceRootListResultSchema } from '@foreman-code/contracts/workspace-root-policies'
import { ApiError, apiClient, getManagedWorkspace } from './client'
import { computerKey, readComputerNames } from './computerActivity'
import { useHarnessSessionEpoch } from './harnessSettings'
import { assertSession, sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export type WorktreeOption = Readonly<{
  rootBinding: SourceRootReference
  label: string
  computer: string
  repository?: string
  commit?: string
  projectRoot?: string
  accessMode: SourceRootRecord['binding']['accessMode']
  unavailableReason?: string
}>
export const worktreeChoicesKey = (workspaceId: string) =>
  ['workbench', 'worktree-choices', sessionGeneration(), workspaceId] as const

export function useSourceRoots(workspaceId: string) {
  useHarnessSessionEpoch()
  const generation = sessionGeneration()
  return useQuery({ queryKey: ['workbench', 'source-roots', generation, workspaceId], retry: false,
    enabled: !sessionIsSwitching(), queryFn: async ({ signal }) => {
      const result = await apiClient.request(`/api/management/workspaces/${encodeURIComponent(workspaceId)}/source-roots`,
        SourceRootListResultSchema, { signal })
      assertSession(generation)
      if (result.items.some(root => root.binding.workspaceId !== workspaceId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Source roots belong to another workspace.' })
      }
      return result
    },
  })
}

export async function readWorktreeChoices(workspaceId: string, signal?: AbortSignal): Promise<WorktreeOption[]> {
  const path = `/api/management/workspaces/${encodeURIComponent(workspaceId)}`
  const [roots, locations, workspace, names] = await Promise.all([
    apiClient.request(`${path}/source-roots`, SourceRootListResultSchema, { signal }),
    apiClient.request(`${path}/root-policies`, WorkspaceRootListResultSchema, { signal }),
    getManagedWorkspace(workspaceId, { signal }),
    readComputerNames(signal),
  ])
  if (locations.workspaceId !== workspaceId || locations.policies.some(policy => policy.workspaceId !== workspaceId)
    || roots.items.some(root => root.binding.workspaceId !== workspaceId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Worktree choices belong to another workspace.' })
  }
  const sources = await Promise.allSettled(roots.items.map(root => apiClient.request(`${path}/sources/get`,
    ApprovedSourceSchema, { method: 'POST', body: { workspaceId, ...root.source }, signal })))
  const configured = workspace.workspace.repository
  const repository = configured ? `${configured.owner}/${configured.name}` : undefined
  return roots.items.map((root, index) => {
    const sourceResult = sources[index]
    const source = sourceResult?.status === 'fulfilled' ? sourceResult.value : undefined
    if (source && (source.workspaceId !== workspaceId || source.manifest.snapshotId !== root.source.snapshotId
      || source.manifest.manifestDigest !== root.source.manifestDigest)) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Worktree source does not match its approved binding.' })
    }
    const policy = locations.policies.find(item => item.rootPolicyId === root.selection.rootPolicyId
      && JSON.stringify(item.hostRef) === JSON.stringify(root.selection.hostRef))
    const git = source?.manifest.git
    const computer = names.get(computerKey(root.selection)) ?? (root.selection.hostRef.kind === 'main' ? 'Main' : `Computer ${root.selection.hostRef.deviceId}`)
    let unavailableReason: string | undefined
    if (!source) unavailableReason = 'Approved source could not be read.'
    else if (source.availability !== 'retained') unavailableReason = 'Approved source files are unavailable.'
    else if (!git?.repository || !git.commit) unavailableReason = 'This source has no approved repository commit.'
    else if (git.repository !== repository) unavailableReason = 'This source belongs to a different repository.'
    else if (!policy || policy.rootPolicyRevision !== root.selection.rootPolicyRevision
      || policy.locationRevision !== root.selection.locationRevision) unavailableReason = 'The root policy changed or is unavailable.'
    else if (root.binding.accessMode !== 'exclusive-write') unavailableReason = 'Agent Git worktrees need a writable source root.'
    return {
      rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision }, computer,
      label: `${computer} · ${git?.repository ?? 'Approved source'} · ${git?.commit.slice(0, 12) ?? 'Commit unavailable'}`,
      accessMode: root.binding.accessMode,
      ...(git?.repository ? { repository: git.repository, commit: git.commit } : {}),
      ...(policy ? { projectRoot: policy.canonicalProjectRoot } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
    }
  })
}

export async function readWorktreeRoot(workspaceId: string, rootBinding: SourceRootReference, signal?: AbortSignal) {
  const result = await apiClient.request(`/api/management/workspaces/${encodeURIComponent(workspaceId)}/source-roots/get`,
    SourceRootRecordSchema, { method: 'POST', body: { workspaceId, ...rootBinding }, signal })
  if (result.binding.workspaceId !== workspaceId || result.binding.rootId !== rootBinding.rootId
    || result.binding.bindingRevision !== rootBinding.bindingRevision) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Worktree readback belongs to another source root.' })
  }
  return result
}

export async function readWorktreeDetails(workspaceId: string, rootBinding: SourceRootReference, signal?: AbortSignal) {
  const root = await readWorktreeRoot(workspaceId, rootBinding, signal)
  const path = `/api/management/workspaces/${encodeURIComponent(workspaceId)}`
  const [source, locations, names] = await Promise.all([
    apiClient.request(`${path}/sources/get`, ApprovedSourceSchema,
      { method: 'POST', body: { workspaceId, ...root.source }, signal }),
    apiClient.request(`${path}/root-policies`, WorkspaceRootListResultSchema, { signal }),
    readComputerNames(signal),
  ])
  if (source.workspaceId !== workspaceId || source.manifest.snapshotId !== root.source.snapshotId
    || source.manifest.manifestDigest !== root.source.manifestDigest || locations.workspaceId !== workspaceId
    || locations.policies.some(policy => policy.workspaceId !== workspaceId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Worktree details do not match the saved source root.' })
  }
  const policy = locations.policies.find(item => item.rootPolicyId === root.selection.rootPolicyId
    && item.rootPolicyRevision === root.selection.rootPolicyRevision
    && item.locationRevision === root.selection.locationRevision
    && JSON.stringify(item.hostRef) === JSON.stringify(root.selection.hostRef))
  const computer = names.get(computerKey(root.selection)) ?? (root.selection.hostRef.kind === 'main' ? 'Main' : `Computer ${root.selection.hostRef.deviceId}`)
  const git = source.manifest.git
  return { rootBinding, computer, accessMode: root.binding.accessMode,
    label: `${computer} · ${git?.repository ?? 'Approved source'} · ${git?.commit.slice(0, 12) ?? 'Commit unavailable'}`,
    ...(git?.repository ? { repository: git.repository, commit: git.commit } : {}),
    ...(policy ? { projectRoot: policy.canonicalProjectRoot } : {}),
    ...(source.availability !== 'retained' ? { unavailableReason: 'Approved source files are unavailable.' } : {}),
  } satisfies WorktreeOption
}

export function useWorktreeChoices(workspaceId: string, enabled = true) {
  useHarnessSessionEpoch()
  const generation = sessionGeneration()
  return useQuery({ queryKey: worktreeChoicesKey(workspaceId), retry: false, enabled: enabled && !sessionIsSwitching(),
    queryFn: async ({ signal }) => {
      const result = await readWorktreeChoices(workspaceId, signal)
      assertSession(generation)
      return result
    },
  })
}
