import { BoardNotice } from './BoardNotice'
import { ZodError } from 'zod'
import { workflowSaveIssues, WorkflowSaveIssuesSchema, type WorkflowSaveIssue } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { Button } from '../../../shared/ui/nocturne'

export function WorkflowSaveError({ error, pending, openField }: {
  error: Error; pending: boolean; openField: (path: WorkflowSaveIssue['path']) => void
}) {
  const api = ApiError.is(error) ? error : undefined
  const parsed = WorkflowSaveIssuesSchema.safeParse(api?.details)
  const issues = parsed.success ? parsed.data.issues : error instanceof ZodError ? workflowSaveIssues(error.issues) : []
  const uncertain = pending && (!api || api.status === 0 || api.status >= 500 || api.code === 'INVALID_RESPONSE')
  const denied = api?.status === 403
  const conflict = !!api && ['REVISION_CONFLICT', 'WORKFLOW_BASE_CONFLICT', 'AGENT_CONFIGURATION_CONFLICT',
    'AGENT_REVISION_CONFLICT'].includes(api.code)
  const title = uncertain ? 'Save not confirmed.' : denied ? 'You can’t save this workflow.'
    : conflict ? 'The workflow changed.' : issues.length ? `Can’t save — fix ${issues.length} ${issues.length === 1 ? 'setting' : 'settings'}` : 'Can’t save.'
  return <BoardNotice noticeKey={error} tone="danger" live title={title}>
    {uncertain ? 'Check the pending save before trying again.'
      : denied ? 'Ask for workflow edit permission.'
        : conflict ? 'Review the latest saved workflow before saving again.'
          : issues.length ? <ul>{issues.map((issue, index) => <li key={index}>
            {issue.message}{' '}
            {['approval', 'executionPolicy', 'entryNodeId'].includes(String(issue.path[0]))
              ? <Button size="sm" variant="ghost" onClick={() => openField(issue.path)}>Fix setting</Button> : null}
          </li>)}</ul> : error.message}
  </BoardNotice>
}
