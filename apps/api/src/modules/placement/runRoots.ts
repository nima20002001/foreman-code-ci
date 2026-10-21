import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import { commandInputHash } from '../commands/postgres.js'

export interface SelectedRunRoot {
  root: SourceRootRecord
  policy: WorkspaceRootPolicy
}

export async function prepareRunRoots(sources: SourceAdmissionPort, principal: ManagementPrincipal,
  input: { workspaceId: string; commandId: string; source: 'http' | 'mcp' },
  selected: readonly SelectedRunRoot[], options: { captureSource: boolean },
): Promise<readonly SourceRootRecord[]> {
  const roots = selected.map(({ root, policy }) => ({ ...root, selection: {
    hostRef: policy.hostRef, rootPolicyId: policy.rootPolicyId,
    rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision,
  } }))
  if (options.captureSource) return sources.prepareRunSources(principal, { ...input, roots })
  const refreshed: SourceRootRecord[] = []
  for (const [index, root] of roots.entries()) {
    if (sameWorkflowValue(root.selection, selected[index]!.root.selection)) {
      refreshed.push(root)
      continue
    }
    const result = await sources.bindRoot(principal, input.source, {
      workspaceId: input.workspaceId,
      commandId: `run-root:${commandInputHash({ principalId: principal.id,
        commandId: input.commandId, rootId: root.binding.rootId })}`,
      expectedBindingRevision: root.binding.bindingRevision,
      source: root.source, selection: root.selection, accessMode: root.binding.accessMode,
    })
    refreshed.push(result.value)
  }
  return refreshed
}
