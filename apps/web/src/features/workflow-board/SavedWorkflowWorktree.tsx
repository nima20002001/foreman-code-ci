import { useQuery } from '@tanstack/react-query'
import type { WorkflowWorktreeSettings } from '@foreman-code/contracts/worktree-settings'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { assertSession, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { readWorktreeDetails } from '../../shared/api/worktreeChoices'

export function SavedWorkflowWorktree({ workspaceId, value }: {
  workspaceId: string; value?: WorkflowWorktreeSettings
}) {
  const generation = useHarnessSessionEpoch()
  const query = useQuery({ queryKey: ['workbench', 'saved-worktree', generation, workspaceId, value?.rootBinding],
    enabled: Boolean(value) && !sessionIsSwitching(), retry: false,
    queryFn: async ({ signal }) => {
      if (!value) throw new Error('No saved default worktree is configured.')
      const result = await readWorktreeDetails(workspaceId, value.rootBinding, signal)
      assertSession(generation)
      return result
    },
  })
  if (sessionIsSwitching()) return null
  const details = !query.isError ? query.data : undefined
  return <section className="saved-workflow-worktree" aria-label="Saved default worktree">
    <strong>Default worktree</strong>
    {!value ? <p>Existing workspace placement saved with this version.</p> : <>
      <p>{details?.label ?? 'Configured source retained'}</p>
      <dl><dt>Saved source root</dt><dd>{value.rootBinding.rootId} · revision {value.rootBinding.bindingRevision}</dd>
        <dt>Agent branch prefix</dt><dd>{value.branchPrefix ?? 'Generated automatically'}</dd>
        {details?.projectRoot && <><dt>Project root</dt><dd>{details.projectRoot}</dd></>}
      </dl>
      {query.isPending && <p role="status">Reading saved worktree details…</p>}
      {(query.isError || details?.unavailableReason) && <p role="status">{details?.unavailableReason
        ?? 'Saved worktree details are unavailable. The original source selection is retained.'}</p>}
    </>}
  </section>
}
