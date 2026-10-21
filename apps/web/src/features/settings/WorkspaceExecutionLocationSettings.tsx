import { sameComputer } from '../../shared/api/sameComputer'
import { errorMessage } from '../../shared/errorMessage'
import { useContext, useEffect, useRef, type RefObject } from 'react'
import { useIsMutating } from '@tanstack/react-query'
import { WorkspaceRootSelectionSchema, type ApprovedRootAllowlist, type WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { locationMutationKey } from '../../shared/api/workspaceLocationCache'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { ApiError } from '../../shared/api/client'
import {
  sameRootSelection, useWorkspaceRootChoices, useBoundWorkspaceLocation,
  useBrowseBoundWorkspaceLocation, useValidateBoundWorkspaceLocation, useSetBoundWorkspaceLocation,
} from '../../shared/api/workspaceBoundLocation'
import { UnsavedEditorGuard } from '../../shared/ui/unsavedChanges'
import { Alert, Button, Dialog, LoadingState, Select, TextField } from '../../shared/ui/nocturne'
import { ToastContext } from '../../shared/ui/nocturne/toastContext'
import { emptyRootPicker as empty, useBoundLocationDraftStore as usePickers, type RootPickerDraft as Picker, type RootCandidate as Candidate } from './workspaceBoundLocationDraftStore'
import { sessionGeneration, sessionSignal } from '../../shared/api/sessionBoundary'
import { WorkspaceLocationCard } from './WorkspaceLocationCard'
import { ComputerPresenceReadback } from './ComputerPresence'
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker'
import { useRuntimeIdentityQuery } from '../../shared/api/runtimeIdentity'
import { useWorkspaceCreationDefaultsQuery } from '../../shared/api/settingsExperience'
import './computerSettings.css'

type Props = { workspaceId: string; presentation?: 'field' | 'card' | 'tile' | 'compact'; onSaved?: () => void; triggerRef?: RefObject<HTMLButtonElement | null> }
function hostLabel(host: WorkspaceRootSelection['hostRef']) { return host.kind === 'main' ? `Main · ${host.mainId}` : `Worker · ${host.deviceId}` }
function revision(value: string | undefined) {
  const result = Number(value ?? 0)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('This root policy revision cannot be represented by the location API.')
  return result
}
function useLocationSettings({ workspaceId, presentation = 'field', onSaved }: Props) {
  const epoch = useHarnessSessionEpoch(), scope = `${epoch}:${workspaceId}`
  const toasts = useContext(ToastContext)
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const identity = useRuntimeIdentityQuery()
  const defaults = useWorkspaceCreationDefaultsQuery(presentation === 'compact')
  const current = workspace.isSuccess && workspace.data.workspace.id === workspaceId ? workspace.data : undefined
  const allowed = Boolean(current && current.locationValidation.status !== 'restricted')
  const saved = useBoundWorkspaceLocation(workspaceId, allowed)
  const choices = useWorkspaceRootChoices(workspaceId, allowed)
  const browse = useBrowseBoundWorkspaceLocation(workspaceId)
  const validate = useValidateBoundWorkspaceLocation(workspaceId)
  const save = useSetBoundWorkspaceLocation(workspaceId)
  type SaveFacts = { selection: WorkspaceRootSelection; host: ApprovedRootAllowlist }
  const operation = useRef({ attempt: new CommandAttempt<SaveFacts>(), original: undefined as SaveFacts | undefined, uncertain: false, saving: false }).current
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    const signal = sessionSignal(), reset = usePickers.getState().reset
    signal.addEventListener('abort', reset, { once: true })
    return () => { active.current = false; signal.removeEventListener('abort', reset) }
  }, [])
  const busy = useIsMutating({ mutationKey: locationMutationKey(workspaceId) }) > 0
  const picker = usePickers(state => state.pickers[scope]) ?? empty()
  const update = usePickers(state => state.update)
  const records = choices.isSuccess ? choices.data.allowlists.flatMap(host => host.bases.map(base => ({ host, base,
    key: JSON.stringify([host.hostRef, host.applicationInstallationId, host.configurationRevision, base.baseId]),
  }))) : []
  const chosen = records.find(record => record.key === picker.selected)
  const candidate = chosen && picker.candidates[chosen.key]
  const selection: WorkspaceRootSelection | undefined = chosen && candidate ? { workspaceId, hostRef: chosen.host.hostRef,
    allowedBaseId: chosen.base.baseId, configurationRevision: chosen.host.configurationRevision, relativePath: candidate.relativePath,
    accessMode: candidate.accessMode, expectedLocationRevision: candidate.locationRevision, expectedRootPolicyRevision: candidate.rootPolicyRevision } : undefined
  const locked = busy || operation.attempt.unresolved || operation.saving && validate.isPending
  const setPickerOpen = (open: boolean) => {
    if (!open && locked) return
    update(scope, previous => ({ ...previous, open }))
    if (!open) {
      browse.reset()
      validate.reset()
    }
  }
  const archived = current?.archivedAt !== null && current?.archivedAt !== undefined
  const conflict = Boolean(picker.conflict || candidate && saved.isSuccess && candidate.locationRevision !== saved.data.locationRevision)
  const change = (apply: (previous: Picker) => Picker) => { if (!locked) update(scope, previous => ({ ...apply(previous), editVersion: previous.editVersion + 1, notice: undefined })) }
  const choose = (key: string) => {
    const record = records.find(value => value.key === key)
    if (!record || !saved.isSuccess || !choices.isSuccess) return
    const previousPolicy = choices.data.policies.find(policy => sameComputer(policy.hostRef, record.host.hostRef))
    change(previous => ({ ...previous, selected: key, candidates: { ...previous.candidates, [key]: previous.candidates[key] ?? {
      relativePath: previousPolicy?.allowedBaseId === record.base.baseId ? previousPolicy.relativePath : '',
      accessMode: previousPolicy?.allowedBaseId === record.base.baseId && record.base.accessModes.includes(previousPolicy.accessMode) ? previousPolicy.accessMode
        : presentation === 'compact' && record.base.accessModes.includes('read-write') ? 'read-write' : record.base.accessModes[0]!,
      locationRevision: saved.data.locationRevision, rootPolicyRevision: revision(previousPolicy?.rootPolicyRevision),
    } } }))
    browse.reset(); validate.reset()
  }
  const mainRecords = records.filter(record => record.host.hostRef.kind === 'main'
    && record.host.hostRef.mainId === identity.data?.installationId && record.host.applicationInstallationId === identity.data?.installationId)
  const savedBinding = saved.data?.evidence === 'bound' ? saved.data.binding : undefined
  const mainRecord = mainRecords.find(record => savedBinding?.hostRef.kind === 'main' && savedBinding.allowedBaseId === record.base.baseId)
    ?? mainRecords.filter(record => saved.data?.executionLocation?.rootPath === record.base.canonicalPath
      || saved.data?.executionLocation?.rootPath.startsWith(`${record.base.canonicalPath.replace(/\/$/, '')}/`))
      .sort((left, right) => right.base.canonicalPath.length - left.base.canonicalPath.length)[0]
    ?? mainRecords.find(record => record.base.canonicalPath === defaults.data?.parentPath)
    ?? (mainRecords.length === 1 ? mainRecords[0] : undefined)
  useEffect(() => {
    // Auto-select only the server's actual Main installation and an approved known base.
    if (presentation === 'compact' && savedBinding?.hostRef.kind !== 'device' && !identity.isError && mainRecord && picker.selected !== mainRecord.key && !locked && saved.isSuccess) choose(mainRecord.key)
  })
  const changeCandidate = (fields: Partial<Candidate>) => {
    if (!chosen || !candidate) return
    change(previous => ({ ...previous, candidates: { ...previous.candidates, [chosen.key]: { ...candidate, ...fields } } }))
    browse.reset(); validate.reset()
  }
  const reload = async () => {
    if (operation.attempt.unresolved) return false
    const version = picker.editVersion
    const [location, roots] = await Promise.all([saved.refetch(), choices.refetch()])
    if (location.isError || roots.isError || !location.data || !roots.data) {
      update(scope, previous => ({ ...previous, notice: 'Saved location could not be reloaded. Your candidate was preserved.' }))
      return false
    }
    update(scope, previous => {
      if (previous.editVersion !== version) return { ...previous, notice: 'Saved location reloaded. Your newer candidate was preserved.' }
      return { ...empty(), open: previous.open, editVersion: previous.editVersion + 1, notice: 'Saved location and root policies reloaded. Select the intended computer again.' }
    })
    return true
  }
  const submit = async (throwFailure = false) => {
    if (operation.saving || busy || validate.isPending || browse.isPending
      || (!operation.attempt.unresolved && (archived || !selection || !chosen || conflict || !WorkspaceRootSelectionSchema.safeParse(selection).success))) return
    const hadUnknownOutcome = operation.uncertain
    const latest = usePickers.getState().pickers[scope] ?? picker
    const submittedVersion = latest.editVersion
    const submittedKey = latest.selected
    const record = records.find(value => value.key === submittedKey)
    const draft = record && latest.candidates[record.key]
    const submitted: WorkspaceRootSelection | undefined = record && draft ? { workspaceId, hostRef: record.host.hostRef,
      allowedBaseId: record.base.baseId, configurationRevision: record.host.configurationRevision, relativePath: draft.relativePath,
      accessMode: draft.accessMode, expectedLocationRevision: draft.locationRevision, expectedRootPolicyRevision: draft.rootPolicyRevision } : undefined
    const readback = saved.isSuccess && saved.data.evidence === 'bound' ? saved.data : undefined
    const binding = readback?.binding
    operation.saving = true
    try {
      if (!operation.attempt.unresolved && submitted && record && readback && binding && sameComputer(binding.hostRef, submitted.hostRef)
        && binding.applicationInstallationId === record.host.applicationInstallationId && binding.allowedBaseId === submitted.allowedBaseId
        && binding.configurationRevision === submitted.configurationRevision && binding.relativePath === submitted.relativePath
        && binding.accessMode === submitted.accessMode && readback.locationRevision === submitted.expectedLocationRevision) {
        const checked = await validate.mutateAsync({ input: submitted, expectedHost: record.host })
        if (!active.current || epoch !== sessionGeneration()) return
        if (checked.attestation.directoryIdentityHash === binding.directoryIdentityHash) {
          update(scope, previous => ({ ...previous, open: false, notice: undefined }))
          return
        }
      }
      operation.original ??= submitted && record ? { selection: submitted, host: record.host } : undefined
      if (!operation.original) return
      const request = operation.attempt.input(operation.original)
      const result = await save.mutateAsync({ input: { ...request.selection, commandId: request.commandId }, expectedHost: request.host })
      operation.attempt.succeeded(); operation.original = undefined; operation.uncertain = false
      update(scope, previous => {
        const newer = previous.editVersion !== submittedVersion
        const candidates = { ...previous.candidates }
        if (submittedKey && candidates[submittedKey] && !newer) candidates[submittedKey] = { ...candidates[submittedKey], locationRevision: result.value.locationRevision,
          rootPolicyRevision: result.value.evidence === 'bound' ? revision(result.value.binding.rootPolicyRevision) : candidates[submittedKey].rootPolicyRevision }
        return { ...previous, candidates, conflict: false, open: newer ? previous.open : false,
          notice: newer ? 'Original folder command confirmed. Your newer candidate remains unsaved.' : `Execution folder command confirmed at location revision ${result.value.locationRevision}. Accepted Runs keep their pins.` }
      })
      toasts?.notify({ tone: 'success', title: 'Folder command confirmed' })
      if (active.current && epoch === sessionGeneration()) onSaved?.()
    } catch (error) {
      // Losing permission to reconcile cannot disprove an earlier possible commit.
      if (!(hadUnknownOutcome && error instanceof ApiError && (error.status === 401 || error.status === 403))) operation.attempt.failed(error)
      operation.uncertain = operation.attempt.unresolved
      if (!operation.attempt.unresolved) operation.original = undefined
      update(scope, previous => ({ ...previous, conflict: error instanceof ApiError && error.status === 409 ? true : previous.conflict, notice: errorMessage(error, 'The folder operation failed.') }))
      if (throwFailure) throw error
    } finally {
      operation.saving = false
    }
  }
  const runBrowse = async () => { if (selection && chosen) try { await browse.mutateAsync({ input: selection, expectedHost: chosen.host }) } catch { /* Mutation exposes the scoped error. */ } }
  const runValidate = async () => { if (selection && chosen) try { await validate.mutateAsync({ input: selection, expectedHost: chosen.host }) } catch { /* Mutation exposes the scoped error. */ } }
  return {
    scope, toasts, workspace, identity, defaults, current, saved, choices, browse, validate, save, operation,
    busy, picker, update, records, chosen, candidate, selection, locked, setPickerOpen, archived, conflict,
    choose, savedBinding, mainRecord, changeCandidate, reload, submit, runBrowse, runValidate,
  }
}

function LocationSettings({ workspaceId, presentation = 'field', onSaved, triggerRef }: Props) {
  const {
    scope, toasts, workspace, identity, defaults, current, saved, choices, browse, validate, save, operation,
    busy, picker, update, records, chosen, candidate, selection, locked, setPickerOpen, archived, conflict,
    choose, savedBinding, mainRecord, changeCandidate, reload, submit, runBrowse, runValidate,
  } = useLocationSettings({
    workspaceId, presentation, onSaved, triggerRef,
  })
  const guard = <UnsavedEditorGuard editor={{ label: 'execution folder command', dirty: operation.attempt.unresolved, busy, uncertain: operation.attempt.unresolved,
    save: submit, discard: () => { if (!operation.attempt.unresolved) update(scope, () => empty()) }, error: save.error?.message }} />
  const recovery = operation.attempt.unresolved ? <><Alert tone="warning" title="A submitted folder command has an unknown outcome. Its original selection is retained." />
    <Button disabled={busy} onClick={() => void submit()}>Reconcile original selection</Button></> : null
  if (!current) return <section aria-label="Project folder">{guard}{recovery}{workspace.isError ? <Alert tone="danger" title="Execution workspace could not be loaded." /> : <LoadingState label="Loading execution workspace…" />}</section>
  if (current.locationValidation.status === 'restricted') return <>{guard}{recovery}<Alert tone="danger" title="You do not have permission to read this workspace’s execution location." /></>
  if (saved.isError || choices.isError) return <section aria-label="Project folder">{guard}{recovery}{archived ? <Alert tone="warning" title="This workspace is archived. Its execution location cannot be edited." /> : null}<Alert tone="danger" title="Project folder or computer roots could not be loaded." /><Button onClick={() => void reload()}>Retry location readback</Button></section>
  if (!saved.isSuccess || !choices.isSuccess) return <>{guard}{recovery}<LoadingState label="Loading saved execution computer and approved roots…" /></>
  const savedPath = saved.data.executionLocation?.rootPath ?? ''
  const browsingCurrent = sameRootSelection(browse.data?.selection, selection)
  const validationCurrent = sameRootSelection(validate.data?.selection, selection)
  if (presentation === 'compact' && savedBinding?.hostRef.kind !== 'device' && !identity.isError && !defaults.isError) {
    if (identity.isPending || mainRecord && (chosen?.key !== mainRecord.key || !selection)) return <section className="workspace-location-form workspace-location-form--compact" aria-label="Project folder">
      {guard}{recovery}<LoadingState label="Reading Main folder settings…" />
    </section>
    if (identity.isSuccess && mainRecord && chosen?.key === mainRecord.key && selection) return <section className="workspace-location-form workspace-location-form--compact" aria-label="Project folder">
      {guard}{recovery}
      <WorkspaceFolderPicker value={savedPath} label="Execution location" presentation="compact" triggerRef={triggerRef}
        directoryBinding={{ input: selection, expectedHost: chosen.host }} disabled={archived || busy}
        onReloadSavedLocation={reload}
        selectionUnconfirmed={operation.attempt.unresolved} onSelect={async (path) => {
          const basePath = chosen.base.canonicalPath.replace(/\/$/, '') || '/'
          const prefix = basePath === '/' ? '/' : `${basePath}/`
          if (path !== basePath && !path.startsWith(prefix)) throw new Error('Choose a folder inside the approved Main location.')
          if (conflict && !operation.attempt.unresolved) throw new Error('The saved location changed. Reload it before selecting another folder.')
          if (!operation.attempt.unresolved) changeCandidate({ relativePath: path === basePath ? '' : path.slice(prefix.length) })
          await submit(true)
        }} />
      {picker.notice ? <p role="status">{picker.notice}</p> : null}
    </section>
  }
  const savedFacts = saved.data.evidence === 'bound' ? <dl className="computer-facts">
    <div><dt>Saved execution computer</dt><dd>{hostLabel(saved.data.binding.hostRef)}</dd></div>
    <div><dt>Application installation</dt><dd>{saved.data.binding.applicationInstallationId}</dd></div>
    <div><dt>Location / root policy revision</dt><dd>{saved.data.locationRevision} / {saved.data.binding.rootPolicyRevision}</dd></div>
  </dl> : saved.data.evidence === 'legacy_missing' ? null : <p>No execution folder has been configured.</p>
  const locationLabel = { field: 'Project folder', card: 'Choose workspace folder',
    tile: 'Execution location', compact: 'Execution location' }[presentation]
  return <section className="workspace-location-form" aria-label="Project folder">
    {guard}
    {archived ? <Alert tone="warning" title="This workspace is archived. Its execution location cannot be edited." /> : null}
    <WorkspaceLocationCard presentation={presentation === 'compact' ? 'compact' : 'card'} label={locationLabel} path={savedPath}
      triggerRef={triggerRef}
      disabled={archived || busy} description="Choose an approved computer and validate its folder." onChoose={() => update(scope, previous => ({ ...previous, open: true }))}
      onCopy={savedPath ? async () => {
        try { await navigator.clipboard.writeText(savedPath); toasts?.notify({ tone: 'success', title: 'Folder path copied' }) }
        catch { toasts?.notify({ tone: 'danger', title: 'Could not copy the folder path' }) }
      } : undefined} />
    {presentation !== 'compact' ? savedFacts : null}
    {picker.notice ? <p role="status">{picker.notice}</p> : null}
    <Dialog open={picker.open} onOpenChange={setPickerOpen} title="Execution folder" busy={locked}
      description="Browsing and validation run on the selected computer. The workspace changes only when the save is confirmed." footer={<>
        <Button disabled={locked} onClick={() => setPickerOpen(false)}>Cancel</Button>
        <Button disabled={archived || busy || validate.isPending || browse.isPending
          || (!operation.attempt.unresolved && (!selection || conflict))} onClick={() => void submit()}>
          {busy ? 'Saving…' : operation.attempt.unresolved ? 'Reconcile original selection' : 'Select location'}
        </Button></>}>
      <Select label="Computer and approved base folder" value={picker.selected ?? ''} disabled={locked || archived}
        options={[{ value: '', label: 'Choose a computer and approved root' }, ...records.map(record => ({ value: record.key, label: `${hostLabel(record.host.hostRef)} · ${record.base.canonicalPath}` }))]}
        onChange={event => choose(event.target.value)} />
      {!records.length ? <Alert tone="warning" title="No approved folders are available for this workspace. A person must approve a computer folder before it can be chosen." /> : null}
      {chosen && candidate ? <>
        <dl className="computer-facts"><div><dt>Approved base</dt><dd>{chosen.base.canonicalPath}</dd></div></dl>
        <details className="computer-details"><summary>Computer installation</summary>
          <dl className="computer-facts"><div><dt>Candidate application installation</dt><dd>{chosen.host.applicationInstallationId}</dd></div></dl></details>
        <ComputerPresenceReadback key={chosen.key} host={chosen.host.hostRef} applicationInstallationId={chosen.host.applicationInstallationId} />
        <TextField label="Relative folder on this computer" value={candidate.relativePath} maxLength={1024} disabled={locked || archived} placeholder="Empty selects the approved base"
          onChange={event => changeCandidate({ relativePath: event.target.value })} />
        <Select label="Folder access" value={candidate.accessMode} disabled={locked || archived} options={chosen.base.accessModes.map(mode => ({ value: mode, label: mode }))}
          onChange={event => changeCandidate({ accessMode: event.target.value as Candidate['accessMode'] })} />
        <div className="computer-actions">
          <Button disabled={locked || browse.isPending || conflict || archived} onClick={() => void runBrowse()}>Browse this computer</Button>
          <Button disabled={locked || validate.isPending || conflict || archived} onClick={() => void runValidate()}>Validate candidate folder</Button>
        </div>
      </> : null}
      {browsingCurrent ? <><ul className="computer-instance-list">{browse.data!.browse.directories.map(directory => <li key={directory.relativePath}>
        <Button disabled={locked} onClick={() => changeCandidate({ relativePath: directory.relativePath })}>{directory.name}</Button></li>)}</ul>
        {browse.data!.browse.truncated ? <p>Directory listing is truncated. Enter an exact relative folder to validate.</p> : null}</> : null}
      {validationCurrent ? <p role="status">Candidate verified on {hostLabel(validate.data!.attestation.hostRef)}: {validate.data!.attestation.canonicalProjectRoot}. Not saved yet.</p> : null}
      {browse.isError && sameRootSelection(browse.variables?.input, selection) ? <p role="alert">{browse.error.message}</p> : null}
      {validate.isError && sameRootSelection(validate.variables?.input, selection) ? <p role="alert">{validate.error.message}</p> : null}
      {operation.attempt.unresolved && !busy ? <Alert tone="warning" title="The save outcome is unknown. Reconcile the original computer and folder selection before making another choice." /> : null}
      {conflict && !operation.attempt.unresolved ? <Alert tone="warning" title="The saved location or root policy changed. Reload before saving this candidate." /> : null}
      {conflict && !operation.attempt.unresolved ? <Button disabled={locked} onClick={() => void reload()}>Reload saved location</Button> : null}
      {picker.notice ? <p role="status">{picker.notice}</p> : null}
    </Dialog>
  </section>
}
export function WorkspaceExecutionLocationSettings(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <LocationSettings key={`${epoch}:${props.workspaceId}`} {...props} />
}
