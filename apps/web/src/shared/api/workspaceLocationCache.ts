import type { ManagedWorkspace } from '@foreman-code/contracts/management'

/** Preserve location ordering without freezing unrelated workspace metadata. */
export function keepLatestWorkspaceLocation(
  previous: ManagedWorkspace | undefined,
  incoming: ManagedWorkspace,
): ManagedWorkspace {
  if (!previous || previous.workspace.id !== incoming.workspace.id
    || incoming.locationValidation.status === 'restricted'
    || previous.locationValidation.status === 'restricted') return incoming
  const previousCheck = 'checkedAt' in previous.locationValidation ? previous.locationValidation.checkedAt : undefined
  const incomingCheck = 'checkedAt' in incoming.locationValidation ? incoming.locationValidation.checkedAt : undefined
  if (previous.locationRevision > incoming.locationRevision
    || (previous.locationRevision === incoming.locationRevision && previousCheck && incomingCheck
      && Date.parse(previousCheck) > Date.parse(incomingCheck))) {
    return {
      ...incoming,
      executionLocation: previous.executionLocation,
      locationRevision: previous.locationRevision,
      locationValidation: previous.locationValidation,
    }
  }
  return incoming
}

/** TanStack Query's structuralSharing boundary receives unknown cache values. */
export function shareManagedWorkspace(previous: unknown, incoming: unknown): ManagedWorkspace {
  return keepLatestWorkspaceLocation(previous as ManagedWorkspace | undefined, incoming as ManagedWorkspace)
}

export const locationMutationKey = (workspaceId: string) => ['workbench', 'workspace-location', workspaceId] as const
