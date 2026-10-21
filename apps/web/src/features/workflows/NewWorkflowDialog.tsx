import { errorMessage } from '../../shared/errorMessage'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useRef, useState } from 'react'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CurrentWorkspaceDetails as WorkspaceDetailsResponse } from '@foreman-code/contracts/wave25'
import { type WorkflowDefinitionV3 as WorkflowDefinition } from '@foreman-code/contracts/wave25'
import { getWorkspaceDetails, listManagedWorkflows } from '../../shared/api/client'
import { queryKeys, useCreateManagedWorkflowMutation } from '../../shared/api/query'
import { Button, Dialog, TextField } from '../../shared/ui/nocturne'

export interface NewWorkflowDialogProps {
  workspaceId: string
  onCreated: (workflowId: string) => void
  onCancel: () => void
}

/** Compact form used by the New workflow dialog. */
export function NewWorkflowDialog({
  workspaceId,
  onCreated,
  onCancel,
}: NewWorkflowDialogProps) {
  const queryClient = useQueryClient()
  const createManagedWorkflow = useCreateManagedWorkflowMutation()
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string>()
  const [createdWorkflow, setCreatedWorkflow] = useState<WorkflowDefinition>()
  const [openError, setOpenError] = useState<string>()
  const defaultNameOptions = queryOptions({
    queryKey: [...queryKeys.managedWorkflows(workspaceId), 'default-name'],
    queryFn: async ({ signal }) => {
      const workflows = await listManagedWorkflows(workspaceId, { signal })
      const names = new Set(workflows.items.map((item) => item.workflow.name))
      let candidate = 'Untitled workflow'
      let suffix = 1
      while (names.has(candidate)) candidate = `Untitled workflow (${suffix++})`
      return candidate
    },
    enabled: !createdWorkflow,
  })
  const defaultName = useQuery(defaultNameOptions)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const created = useRef(false)
  const attempt = useRef(new CommandAttempt<{ workspaceId: string; name: string }>())
  const openingMutation = useMutation({ retry: false, mutationFn: async (workflow: WorkflowDefinition) => {
    const generation = sessionGeneration(), detailsKey = queryKeys.workspaceDetails(workspaceId)
    await queryClient.cancelQueries({ queryKey: detailsKey })
    if (!queryClient.getQueryData(detailsKey)) await queryClient.fetchQuery({
      queryKey: detailsKey, queryFn: ({ signal }) => getWorkspaceDetails({ workspaceId }, { signal }),
    })
    assertSession(generation)
    queryClient.setQueryData<WorkspaceDetailsResponse>(detailsKey, (current) => current && ({
      ...current, workflows: current.workflows.some((item) => item.id === workflow.id)
        ? current.workflows.map((item) => item.id === workflow.id ? workflow : item)
        : [...current.workflows, workflow],
    }))
    void queryClient.invalidateQueries({ queryKey: detailsKey, refetchType: 'none' })
  } })
  const pending = createManagedWorkflow.isPending || openingMutation.isPending
  const uncertain = attempt.current.unresolved && !pending

  const openCreated = async (workflow: WorkflowDefinition) => {
    if (inFlight.current) return
    inFlight.current = true
    setOpenError(undefined)
    try {
      await openingMutation.mutateAsync(workflow)
      onCreated(workflow.id)
    } catch {
      setOpenError('Workflow created, but its graph could not be opened. Retry opening it.')
    } finally {
      inFlight.current = false
    }
  }

  const create = async () => {
    if (inFlight.current) return
    if (createdWorkflow) { await openCreated(createdWorkflow); return }
    inFlight.current = true
    const generation = sessionGeneration()
    setNameError(undefined)
    let workflow: WorkflowDefinition | undefined
    try {
      const workflowName = name.trim() || await queryClient.fetchQuery(defaultNameOptions)
      assertSession(generation)
      setName(workflowName)
      const input = { workspaceId, name: workflowName }
      workflow = (await createManagedWorkflow.mutateAsync(attempt.current.input(input))).value.workflow
      assertSession(generation)
      attempt.current.succeeded()
      created.current = true
      setCreatedWorkflow(workflow)
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) })
    } catch (error) {
      attempt.current.failed(error)
      if (sessionGeneration() === generation) setNameError(errorMessage(error, 'The workflow could not be created.'))
    } finally { inFlight.current = false }
    if (workflow && created.current) await openCreated(workflow)
  }

  const leave = useUnsavedChanges({ scope: 'surface', label: 'new workflow', get dirty() { return !created.current && Boolean(name) },
    get busy() { return inFlight.current && !created.current }, uncertain, error: nameError, save: create,
    discard: () => { setName(''); setNameError(undefined) },
  })
  const close = () => { if (!inFlight.current && !attempt.current.unresolved) void leave(onCancel) }

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => { if (!nextOpen) close() }}
      title="New workflow"
      busy={pending || uncertain}
      closeOnOutsideClick
      initialFocusRef={nameInputRef}
    >
      <form className="new-workflow-form" aria-label="New workflow" noValidate onSubmit={(event) => { event.preventDefault(); void create() }}>
        <TextField
          ref={nameInputRef}
          id="new-workflow-name"
          label="Name"
          name="name"
          type="text"
          value={name}
          placeholder={defaultName.data ?? 'Untitled workflow'}
          disabled={pending || uncertain || Boolean(createdWorkflow)}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? 'new-workflow-name-error' : undefined}
          onChange={(event) => {
            setName(event.target.value)
            if (nameError) setNameError(undefined)
          }}
        />
        {nameError ? (
          <p id="new-workflow-name-error" className="new-workflow-error" role="alert">
            {nameError}
          </p>
        ) : null}

        {uncertain ? <p role="status">The previous request may have succeeded. Retry Create workflow to resolve it without creating a duplicate.</p> : null}
        {openError ? <p role="alert">{openError}</p> : null}
        <div className="new-workflow-actions">
          <Button onClick={close} disabled={pending || uncertain}>
            {createdWorkflow ? 'Close' : 'Cancel'}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {createdWorkflow ? 'Open workflow' : 'Create workflow'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
