import type { WorkflowWorktreeSettings } from '@foreman-code/contracts/worktree-settings'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { WorktreeOption } from '../../shared/api/worktreeChoices'

export function worktreeLabel(value: WorkflowWorktreeSettings | undefined, options: readonly WorktreeOption[]) {
  if (!value) return 'workspace default'
  return options.find(option => sameWorkflowValue(option.rootBinding, value.rootBinding))?.label
    ?? 'Configured source retained'
}
