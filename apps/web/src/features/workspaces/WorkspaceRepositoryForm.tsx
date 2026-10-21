import { InfoHint } from '../../shared/ui/InfoHint'
import { useQueryClient } from '@tanstack/react-query'
import { WorkspaceRepositorySchema, type WorkspaceRepository } from '@foreman-code/contracts'
import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import {
  WorkspaceRepositoryAddInputSchema, type WorkspaceRepositoryReadResult,
} from '@foreman-code/contracts/workspace-git'
import { useState } from 'react'
import { ApiError } from '../../shared/api/client'
import { queryKeys, useUpdateManagedWorkspaceMutation } from '../../shared/api/query'
import { useBoundWorkspaceLocation, useWorkspaceRootChoices } from '../../shared/api/workspaceBoundLocation'
import {
  originalRepositoryRequest, useAddWorkspaceRepository, useWorkspaceRepository, workspaceGitKeys,
} from '../../shared/api/workspaceGit'
import { useSourceRoots } from '../../shared/api/worktreeChoices'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { keepLatestWorkspaceLocation } from '../../shared/api/workspaceLocationCache'
import { Alert, Button, Select, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useRevisionedForm } from '../settings/revisionedForm'

interface RepositoryFields { slug: string; branch: string }

function repositoryFields(repository: WorkspaceRepository | undefined): RepositoryFields | null {
  return repository ? { slug: `${repository.owner}/${repository.name}`, branch: repository.defaultBranch } : null
}

function repositoryInput(fields: RepositoryFields | null) {
  if (!fields) return null
  const match = /^(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+)\/?$/u.exec(fields.slug.trim())
  return {
    provider: 'github',
    owner: match?.[1],
    name: match?.[2]?.replace(/\.git$/u, ''),
    defaultBranch: fields.branch.trim(),
  }
}

/** Agents in this workspace's Runs each get their own worktree and branch of this GitHub repository. */
export function WorkspaceRepositoryForm({ workspaceId, revision, repository }: {
  workspaceId: string; revision: number; repository: WorkspaceRepository | undefined
}) {
  const cache = useQueryClient()
  const update = useUpdateManagedWorkspaceMutation()
  const prepare = useAddWorkspaceRepository(workspaceId)
  const form = useRevisionedForm({ value: repositoryFields(repository), revision }, `repository:${workspaceId}`)
  const originalImport = originalRepositoryRequest(cache, workspaceId, form.pendingCommandId)
  const project = useWorkspaceRepository(workspaceId, originalImport?.commandId)
  const status = !project.isError ? project.data : undefined
  const canResume = status?.state === 'preparing' || status?.state === 'failed'
    && status.operation?.failure?.retryable === true && !status.operation.failure.newCommandRequired
  const recoveredImport = canResume ? status?.operation?.retryInput : undefined
  const retryInput = originalImport ?? recoveredImport
  const importPending = Boolean(retryInput)
  const roots = useWorkspaceRootChoices(workspaceId)
  const location = useBoundWorkspaceLocation(workspaceId)
  const sourceRoots = useSourceRoots(workspaceId)
  const [selectedBase, setSelectedBase] = useState('')
  const bases = (roots.isError ? [] : roots.data?.allowlists ?? []).flatMap(allowlist =>
    allowlist.hostRef.kind === 'main' ? allowlist.bases.filter(base => base.accessModes.includes('read-write'))
      .map(base => ({ base, allowlist })) : [])
  const base = bases.find(item => item.base.baseId === selectedBase) ?? (bases.length === 1 ? bases[0] : undefined)
  const fields = repositoryFields(retryInput?.repository) ?? form.draft ?? { slug: '', branch: 'main' }
  const parsed = WorkspaceRepositorySchema.nullable().safeParse(repositoryInput(form.draft ?? null))
  const issues = parsed.success ? [] : parsed.error.issues
  const repositoryInvalid = issues.some(issue => issue.path[0] === 'owner' || issue.path[0] === 'name')
  const branchError = issues.find(issue => issue.path[0] === 'defaultBranch')?.message
  const incomplete = status?.state === 'preparing'
  const busy = form.isSaving || prepare.isPending
  const uncertain = form.uncertain || incomplete || Boolean(recoveredImport)
  const locked = busy || uncertain
  const conflict = form.conflicted && !form.uncertain
  const saveDisabled = !parsed.success || conflict
  const saveMetadata = () => form.save(async (input) => {
    const generation = sessionGeneration()
    const value = WorkspaceRepositorySchema.nullable().parse(repositoryInput(input.value))
    try {
      const result = await update.mutateAsync({ workspaceId, commandId: input.commandId,
        expectedRevision: input.expectedRevision, repository: value })
      assertSession(generation)
      cache.setQueryData<ManagedWorkspace>(queryKeys.managedWorkspace(workspaceId), (current) => {
        if (current && current.revision > result.value.revision) return current
        return keepLatestWorkspaceLocation(current, result.value)
      })
      void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
      void cache.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
      void cache.invalidateQueries({ queryKey: workspaceGitKeys.scope(workspaceId) })
      return { value: repositoryFields(result.value.workspace.repository), revision: result.value.revision }
    } catch (error) {
      if (generation === sessionGeneration() && error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
        await cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      }
      throw error
    }
  }, (draft) => {
    WorkspaceRepositorySchema.nullable().parse(repositoryInput(draft))
    return draft
  })
  const snapshot = (result: WorkspaceRepositoryReadResult) => {
    if (result.state !== 'ready') {
      const failure = result.operation?.failure
      const rejected = result.state === 'conflict' || failure?.newCommandRequired || failure?.retryable === false
      throw new ApiError({ code: rejected ? 'IMPORT_REJECTED' : 'IMPORT_INCOMPLETE',
        message: failure?.message ?? 'Project preparation is incomplete. Check its status or retry preparation.' },
      rejected ? 409 : 503)
    }
    cache.setQueryData(workspaceGitKeys.read(workspaceId), result)
    void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
    void cache.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
    return { value: repositoryFields(result.repository ?? undefined), revision: result.revision }
  }
  const resumeProject = async () => {
    if (!recoveredImport || busy) return false
    try {
      const result = await prepare.mutateAsync(recoveredImport)
      const persisted = snapshot(result.value)
      form.acknowledge(form.draft ?? null, persisted.value, persisted.revision)
      return true
    } catch (error) {
      if (error instanceof ApiError && error.code === 'IMPORT_REJECTED') {
        void cache.invalidateQueries({ queryKey: workspaceGitKeys.scope(workspaceId) })
      }
      // Request errors are shown by the mutation; incomplete results remain in project readback.
      return false
    }
  }
  const prepareProject = () => recoveredImport && !originalImport ? resumeProject() : form.save(async input => {
    const generation = sessionGeneration()
    const prior = originalRepositoryRequest(cache, workspaceId, input.commandId)
    if (!prior && (!base || !location.data || !sourceRoots.data
      || roots.isError || location.isError || sourceRoots.isError)) {
      throw new ApiError({ code: 'INVALID_REQUEST', message: 'Select an available approved Main location before adding the project.' })
    }
    const policy = roots.data?.policies.find(item => item.hostRef.kind === 'main')
    const bindingRevision = Math.max(0, ...(sourceRoots.data?.items ?? [])
      .filter(root => root.selection.hostRef.kind === 'main' && root.selection.rootPolicyId === policy?.rootPolicyId)
      .map(root => root.binding.bindingRevision))
    const request = prior ?? WorkspaceRepositoryAddInputSchema.parse({
      workspaceId, commandId: input.commandId, expectedRevision: input.expectedRevision,
      repository: WorkspaceRepositorySchema.parse(repositoryInput(input.value)),
      expectedLocationRevision: location.data!.locationRevision,
      expectedRootPolicyRevision: policy ? Number(policy.rootPolicyRevision) : 0,
      expectedBindingRevision: bindingRevision,
      allowedBaseId: base!.base.baseId, configurationRevision: base!.allowlist.configurationRevision,
    })
    const result = await prepare.mutateAsync(request)
    assertSession(generation)
    return snapshot(result.value)
  }, draft => {
    WorkspaceRepositorySchema.parse(repositoryInput(draft))
    return draft
  })
  const save = () => !repository || importPending ? prepareProject() : saveMetadata()
  const preparationDisabled = !parsed.success || !form.draft || conflict || !base
    || roots.isError || location.isError || sourceRoots.isError || !location.data || !sourceRoots.data
  const draftSaveDisabled = repository ? saveDisabled : preparationDisabled
  const navigationSaveDisabled = uncertain ? !importPending && !form.uncertain : draftSaveDisabled
  const leave = useUnsavedChanges({ scope: 'surface', label: 'repository settings', dirty: form.isDirty,
    busy, uncertain,
    saveDisabled: navigationSaveDisabled,
    error: conflict ? 'Review the repository conflict before saving.' : form.error, save, discard: form.reset })
  return <section className="workspace-repository" aria-label="GitHub repository">
    <h2>GitHub repository</h2>
    <div className="workspace-repository-fields">
      <TextField label="Repository"
        labelHint={<InfoHint label="Repository">Each agent in a run gets its own branch and worktree of this repository on its computer.</InfoHint>} placeholder="owner/name" value={fields.slug} disabled={locked}
        onChange={event => form.setDraft({ ...fields, slug: event.target.value })}
        error={fields.slug && repositoryInvalid
          ? 'Use owner/name or a GitHub repository URL without extra path segments.' : undefined} />
      <TextField label="Base branch" value={fields.branch} disabled={locked}
        onChange={event => form.setDraft({ ...fields, branch: event.target.value })} error={branchError} />
    </div>
    {status?.state !== 'ready' && <>
      <Select label="Project location on Main" value={base?.base.baseId ?? ''} disabled={locked}
        options={[{ value: '', label: 'Choose an approved location', disabled: true },
          ...bases.map(item => ({ value: item.base.baseId, label: item.base.canonicalPath }))]}
        onChange={event => setSelectedBase(event.target.value)} />
      {!base && !roots.isPending && <p role="status">An approved writable Workspaces location on Main is required.</p>}
    </>}
    <RepositoryProjectStatus result={status} loading={project.isPending} />
    {status && status.state !== 'ready' && <Button disabled={form.isSaving || project.isFetching}
      onClick={() => void project.refetch()}>Check project status</Button>}
    {project.isError && <Alert tone="warning" title="Project status could not be read."
      action={<Button disabled={form.isSaving} onClick={() => void project.refetch()}>Check project status</Button>} />}
    {conflict && <Alert tone="warning" title="Repository settings changed elsewhere. Your edits are preserved.">
      <p>Saved repository: {repository ? `${repository.owner}/${repository.name} (${repository.defaultBranch})` : 'None'}.</p>
      <Button disabled={locked} onClick={form.reapply}>Reapply my edits</Button>
      <Button disabled={locked} onClick={form.reset}>Discard edits and load saved repository</Button>
    </Alert>}
    {form.error && !conflict && <Alert tone="danger" title={form.error} />}
    {!form.error && prepare.isError && <Alert tone="danger" title={prepare.error.message} />}
    {incomplete && !importPending && <p role="status">This incomplete import cannot be retried with this access.
      Check project status to see whether preparation has finished.</p>}
    {uncertain && <Alert tone="warning" title={importPending || incomplete
      ? 'Project preparation is unconfirmed. Retry the original request before editing or leaving.'
      : 'The repository save is unconfirmed. Retry before editing or leaving.'} />}
    <div className="workspace-repository-actions">
      {(!repository || status?.state !== 'ready' || importPending) && <Button variant="primary"
        disabled={busy || (!importPending && (locked || preparationDisabled))}
        onClick={() => void prepareProject()}>{importPending ? 'Retry project preparation' : repository ? 'Prepare project' : 'Add project'}</Button>}
      {(!repository || status?.state !== 'ready' || importPending) && <InfoHint label="Add project">Add project prepares a clone on Main and approves the supported tracked files from this base branch.</InfoHint>}
      {repository && !importPending && <Button variant={status?.state === 'ready' ? 'primary' : 'secondary'}
        disabled={form.isSaving || incomplete || (!form.uncertain && (saveDisabled || !form.isDirty))}
        onClick={() => void saveMetadata()}>{form.uncertain ? 'Retry repository save' : 'Save repository'}</Button>}
      {repository && <Button variant="ghost" disabled={locked || conflict}
        onClick={() => void leave(() => { form.setDraft(null); void save() })}>Remove</Button>}
    </div>
  </section>
}

function RepositoryProjectStatus({ result, loading }: { result?: WorkspaceRepositoryReadResult; loading: boolean }) {
  if (!result) return loading ? <p role="status">Reading project status…</p> : null
  if (result.state === 'unconfigured') return <p role="status">No project has been added.</p>
  if (result.state === 'metadata-only') return <p role="status">Repository saved. Project preparation is still needed.</p>
  if (result.state !== 'ready') return <Alert tone="warning" title={result.state === 'preparing'
    ? 'Project preparation is incomplete.' : 'Project could not be prepared.'}>
    <p>Last completed step: {result.operation?.phase ?? 'Unknown'}.</p>
    {result.operation?.failure && <p>{result.operation.failure.message}</p>}
    {result.operation?.failure?.newCommandRequired && <p>A new import attempt is required.</p>}
  </Alert>
  return <div className="workspace-project-readback" role="status">
    <strong>Project ready</strong>
    <dl>
      <dt>Clone location</dt><dd>{result.location?.evidence === 'bound' ? result.location.binding.canonicalProjectRoot : 'Unavailable'}</dd>
      <dt>Base branch</dt><dd>{result.repository?.defaultBranch}</dd>
      <dt>Approved commit</dt><dd><code>{result.approvedSource?.manifest.git?.commit}</code></dd>
      <dt>Source files</dt><dd>{result.approvedSource?.availability}</dd>
    </dl>
  </div>
}
