import { useRef, useState, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { WorkflowArchiveInput } from '@foreman-code/contracts/management'
import type { apiClient } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { queryKeys, useArchiveManagedWorkflowMutation } from '../../shared/api/query'
import { Alert, Button, Dialog, Icon, IconButton } from '../../shared/ui/nocturne'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'

export function RemoveWorkflowButton({ workspaceId, workflowId, name, revision, renderTrigger }: {
  workspaceId: string; workflowId: string; name: string; revision: number
  renderTrigger?: (open: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [baseRevision, setBaseRevision] = useState(revision)
  const cancel = useRef<HTMLButtonElement>(null)
  const mutation = useArchiveManagedWorkflowMutation()
  const client = useQueryClient()
  const router = useRouter()
  const attempt = useRef(new CommandAttempt<Omit<WorkflowArchiveInput, 'commandId'>>())
  const original = useRef<{ workspaceId: string; workflowId: string; expectedRevision: number } | undefined>(undefined)
  const inFlight = useRef(false)
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      if (!attempt.current.unresolved) original.current = { workspaceId, workflowId, expectedRevision: renderTrigger ? baseRevision : revision }
      const result = await mutation.mutateAsync(attempt.current.input(original.current!))
      assertSession(generation)
      attempt.current.succeeded()
      setOpen(false)
      client.setQueryData(queryKeys.managedWorkflow(workspaceId, workflowId), result.value)
      client.setQueriesData<InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkflowPage>>>>({ queryKey: [...queryKeys.managedWorkflows(workspaceId), 'pages'] },
        (current) => current ? { ...current, pages: current.pages.map((page) => ({ ...page,
          items: page.items.filter((item) => item.workflow.id !== workflowId) })) } : current)
      const location = router.state.location
      if (location.pathname === `/workspaces/${encodeURIComponent(workspaceId)}` && location.search.workflowId === workflowId) {
        await router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, search: {}, replace: true })
      }
      useGraphDraftStore.getState().dropNextDraft(nextDraftKey(workspaceId, workflowId))
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) })
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    } catch (error) { attempt.current.failed(error) }
    finally { inFlight.current = false }
  }
  return <>
    {renderTrigger ? renderTrigger(() => { if (!mutation.isPending && !attempt.current.unresolved) { setBaseRevision(revision); mutation.reset(); setOpen(true) } }) : <IconButton label={mutation.isError ? `Retry removing ${name}` : `Remove ${name}`} variant="ghost" size="sm"
      className="workflow-navigation-remove" disabled={mutation.isPending} onClick={() => void remove()}>
      <Icon name="trash" size={14} />
    </IconButton>}
    {renderTrigger ? <Dialog open={open} title={`Remove ${name}?`} size="sm" initialFocusRef={cancel}
      description="This workflow will be removed from the workspace. Workflow and run history is retained. Workflows with active runs cannot be removed."
      busy={mutation.isPending || attempt.current.unresolved} onOpenChange={(next) => { if (!next && !mutation.isPending && !attempt.current.unresolved) { setOpen(false); mutation.reset() } }}
      footer={<><Button ref={cancel} disabled={mutation.isPending || attempt.current.unresolved} onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="danger" disabled={mutation.isPending} onClick={() => void remove()}>{mutation.isPending ? 'Removing…' : attempt.current.unresolved ? 'Retry removal' : 'Remove workflow'}</Button></>}>
      {mutation.isError ? <Alert tone="danger" live title={mutation.error.message} /> : null}
      {attempt.current.unresolved && !mutation.isPending ? <p role="status">The request may have succeeded. Retry removal to confirm its outcome.</p> : null}
    </Dialog> : mutation.isError ? <p className="workflow-navigation-remove-error" role="alert">{mutation.error.message}</p> : null}
  </>
}
