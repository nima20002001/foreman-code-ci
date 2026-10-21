import { sameComputer } from './sameComputer'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  WorkspaceRootListResultSchema, WorkspaceRootSelectionSchema,
  type ApprovedRootAllowlist, type WorkspaceRootSelection,
} from '@foreman-code/contracts/workspace-root-policies'
import {
  WorkspaceBoundLocationReadbackSchema, WorkspaceBoundLocationSetInputSchema, WorkspaceBoundLocationSetResultSchema,
  WorkspaceBoundLocationValidationSchema, WorkspaceBoundLocationBrowseResultSchema,
  type WorkspaceBoundLocationReadback, type WorkspaceBoundLocationSetInput,
} from '@foreman-code/contracts/workspace-bound-location'
import { ApiError, apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'
import { locationMutationKey } from './workspaceLocationCache'
import { queryKeys } from './query'
import { HarnessDirectoryBrowseResultSchema } from '@foreman-code/contracts/management'

export const boundLocationKeys = {
  root: ['workbench', 'bound-workspace-location'] as const,
  scope: (workspaceId: string, generation = sessionGeneration()) => [...boundLocationKeys.root, generation, workspaceId] as const,
  read: (workspaceId: string, generation = sessionGeneration()) => [...boundLocationKeys.scope(workspaceId, generation), 'read'] as const,
  choices: (workspaceId: string) => [...boundLocationKeys.scope(workspaceId), 'choices'] as const,
}
const path = (workspaceId: string) => `/api/management/workspaces/${encodeURIComponent(workspaceId)}`
export function sameRootSelection(left: WorkspaceRootSelection | undefined, right: WorkspaceRootSelection | undefined) {
  const before = WorkspaceRootSelectionSchema.safeParse(left), after = WorkspaceRootSelectionSchema.safeParse(right)
  return before.success && after.success && JSON.stringify(before.data) === JSON.stringify(after.data)
}
function invalid(message: string): never { throw new ApiError({ code: 'INVALID_RESPONSE', message }) }
export function useWorkspaceRootChoices(workspaceId: string, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: boundLocationKeys.choices(workspaceId), enabled: enabled && !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      const result = await apiClient.request(`${path(workspaceId)}/root-policies`, WorkspaceRootListResultSchema, { signal })
      if (result.workspaceId !== workspaceId || result.policies.some(value => value.workspaceId !== workspaceId)) invalid('Root choices belong to another workspace.')
      return result
    } })
}
export function useBoundWorkspaceLocation(workspaceId: string, enabled = true) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: boundLocationKeys.read(workspaceId), enabled: enabled && !sessionIsSwitching(), retry: false,
    structuralSharing: (previous, incoming) => {
      const before = previous as WorkspaceBoundLocationReadback | undefined, next = incoming as WorkspaceBoundLocationReadback
      return before && before.locationRevision > next.locationRevision ? before : next
    },
    queryFn: async ({ signal }) => {
      const result = await apiClient.request(`${path(workspaceId)}/root-location`, WorkspaceBoundLocationReadbackSchema, { signal })
      if (result.workspaceId !== workspaceId || result.evidence === 'bound' && result.binding.workspaceId !== workspaceId) invalid('Bound location belongs to another workspace.')
      return result
    } })
}
/** Expected host metadata is a client acknowledgement fence, never sent as authority. */
type ReadRequest = { input: WorkspaceRootSelection; expectedHost: ApprovedRootAllowlist }
export type BoundFolderBrowser = ReadRequest
function checkRequestHost(input: WorkspaceRootSelection, host: ApprovedRootAllowlist, workspaceId: string) {
  if (input.workspaceId !== workspaceId || !sameComputer(input.hostRef, host.hostRef) || input.configurationRevision !== host.configurationRevision
    || !host.bases.some(base => base.baseId === input.allowedBaseId && base.accessModes.includes(input.accessMode)))
    throw new ApiError({ code: 'INVALID_REQUEST', message: 'Select a current approved root for this workspace and computer.' })
}
export function useBrowseBoundWorkspaceLocation(workspaceId: string) {
  return useMutation({ mutationKey: [...boundLocationKeys.scope(workspaceId), 'browse'], mutationFn: async ({ input, expectedHost }: ReadRequest) => {
    checkRequestHost(input, expectedHost, workspaceId)
    const result = await apiClient.request(`${path(workspaceId)}/root-location/browse`, WorkspaceBoundLocationBrowseResultSchema,
      { method: 'POST', body: WorkspaceRootSelectionSchema.parse(input) })
    if (result.workspaceId !== workspaceId || !sameRootSelection(result.selection, input) || !sameComputer(input.hostRef, expectedHost.hostRef)) invalid('Directory readback belongs to another root selection.')
    return result
  } })
}
/** Present the familiar folder browser using the native, approved Main root transport. */
export function useBoundFolderDirectories(binding: BoundFolderBrowser | undefined, location: { rootId?: string; path?: string; cursor?: string }, enabled: boolean) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: [...boundLocationKeys.scope(binding?.input.workspaceId ?? ''), 'folders', binding, location],
    enabled: enabled && Boolean(binding) && !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      if (!binding || binding.input.hostRef.kind !== 'main') throw new ApiError({ code: 'INVALID_REQUEST', message: 'The folder browser requires an approved Main location.' })
      const base = binding.expectedHost.bases.find(base => base.baseId === binding.input.allowedBaseId)
      if (!base) throw new ApiError({ code: 'INVALID_REQUEST', message: 'The approved folder is no longer available.' })
      const rootPath = base.canonicalPath.replace(/\/$/, '') || '/'
      const selectedPath = location.path ?? rootPath
      const prefix = rootPath === '/' ? '/' : `${rootPath}/`
      if (selectedPath !== rootPath && !selectedPath.startsWith(prefix)) throw new ApiError({ code: 'INVALID_REQUEST', message: 'Choose a folder inside the approved Main location.' })
      const input = WorkspaceRootSelectionSchema.parse({ ...binding.input, relativePath: selectedPath === rootPath ? '' : selectedPath.slice(prefix.length) })
      checkRequestHost(input, binding.expectedHost, input.workspaceId)
      const result = await apiClient.request(`${path(input.workspaceId)}/root-location/browse`, WorkspaceBoundLocationBrowseResultSchema,
        { method: 'POST', body: input, signal })
      if (result.workspaceId !== input.workspaceId || !sameRootSelection(result.selection, input)) invalid('Folder browsing returned another approved root selection.')
      const fullPath = (relativePath: string) => relativePath ? `${prefix}${relativePath}` : rootPath
      const parentRelative = result.browse.relativePath.split('/').slice(0, -1).join('/')
      const directories = result.browse.directories.filter(directory => !location.cursor || directory.name > location.cursor)
      const page = directories.slice(0, 100)
      return { ...HarnessDirectoryBrowseResultSchema.parse({ roots: [{ id: base.baseId, label: 'Workspaces', path: rootPath }],
        rootId: base.baseId, path: fullPath(result.browse.relativePath), parent: result.browse.relativePath ? fullPath(parentRelative) : null,
        directories: page.map(directory => ({ name: directory.name, path: fullPath(directory.relativePath) })),
        nextCursor: directories.length > page.length ? page.at(-1)?.name ?? null : null }), truncated: result.browse.truncated }
    } })
}
export function useValidateBoundWorkspaceLocation(workspaceId: string) {
  return useMutation({ mutationKey: [...boundLocationKeys.scope(workspaceId), 'validate'], mutationFn: async ({ input, expectedHost }: ReadRequest) => {
    checkRequestHost(input, expectedHost, workspaceId)
    const result = await apiClient.request(`${path(workspaceId)}/root-location/validate`, WorkspaceBoundLocationValidationSchema,
      { method: 'POST', body: WorkspaceRootSelectionSchema.parse(input) })
    const proof = result.attestation
    if (result.workspaceId !== workspaceId || !sameRootSelection(result.selection, input) || !sameComputer(proof.hostRef, input.hostRef)
      || proof.applicationInstallationId !== expectedHost.applicationInstallationId || proof.allowedBaseId !== input.allowedBaseId
      || proof.configurationRevision !== input.configurationRevision || proof.relativePath !== input.relativePath || proof.accessMode !== input.accessMode)
      invalid('Folder validation does not match the selected computer and approved root.')
    return result
  } })
}
export function useSetBoundWorkspaceLocation(workspaceId: string) {
  const client = useQueryClient(), generation = useHarnessSessionEpoch()
  return useMutation({ mutationKey: [...locationMutationKey(workspaceId), generation, 'bound-set'],
    mutationFn: async ({ input, expectedHost }: { input: WorkspaceBoundLocationSetInput; expectedHost: ApprovedRootAllowlist }) => {
      checkRequestHost(input, expectedHost, workspaceId)
      const parsed = WorkspaceBoundLocationSetInputSchema.safeParse(input)
      if (!parsed.success) throw new ApiError({ code: 'INVALID_REQUEST', message: 'The selected folder request is invalid.', details: { issues: parsed.error.issues } })
      const result = await apiClient.request(`${path(workspaceId)}/root-location`, WorkspaceBoundLocationSetResultSchema,
        { method: 'PUT', body: parsed.data })
      const value = result.value
      if (value.evidence !== 'bound' || value.workspaceId !== workspaceId || value.binding.workspaceId !== workspaceId) invalid('The submitted workspace root binding was not confirmed.')
      const binding = value.binding
      if (!sameComputer(binding.hostRef, input.hostRef) || binding.applicationInstallationId !== expectedHost.applicationInstallationId
        || binding.allowedBaseId !== input.allowedBaseId || binding.configurationRevision !== input.configurationRevision
        || binding.relativePath !== input.relativePath || binding.accessMode !== input.accessMode
        || value.locationRevision !== input.expectedLocationRevision + (input.hostRef.kind === 'main' ? 1 : 0) || binding.locationRevision !== String(value.locationRevision)
        || binding.rootPolicyRevision !== String(input.expectedRootPolicyRevision + 1)
        || value.executionLocation.rootPath !== binding.canonicalProjectRoot
        || binding.hostRef.kind === 'device' && binding.registration?.workerInstallationId !== expectedHost.applicationInstallationId
        || binding.hostRef.kind === 'main' && binding.registration !== null)
        invalid('Saved location acknowledgement does not match the submitted computer, root or revisions.')
      return result
    },
    onSuccess: result => {
      if (generation !== sessionGeneration()) return
      if (result.value.evidence === 'bound' && result.value.binding.hostRef.kind === 'main') {
        client.setQueryData<WorkspaceBoundLocationReadback>(boundLocationKeys.read(workspaceId, generation),
          previous => previous && previous.locationRevision > result.value.locationRevision ? previous : result.value)
      }
      void client.invalidateQueries({ queryKey: boundLocationKeys.scope(workspaceId, generation) })
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
    },
  })
}
