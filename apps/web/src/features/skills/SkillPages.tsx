import { errorMessage } from '../../shared/errorMessage'
import { useId, useRef, useState } from 'react'
import { useArchiveSkillMutation, useSkillQuery, useSkillUsageQuery, useSkillVersionsQuery, useUpdateSkillUsersMutation } from './skillsApi'
import { Alert, Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Icon, LoadingState } from '../../shared/ui/nocturne'
import { ProtectedAccessError } from '../../shared/ui/ProtectedAccessError'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { SkillEditor, SkillTextPreview, type SavedSkill } from './SkillEditor'
import { useWorkspaceNames } from './workspaceNames'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useSkillAssignments } from './skillAssignments'
import './skills.css'

export function NewSkillPage({ workspaceId, onSaved, onCancel }: { workspaceId?: string | undefined; onSaved(result: SavedSkill): void; onCancel(): void }) {
  const { workspaces, options } = useWorkspaceNames()
  const accessError = useProtectedAccessError(workspaces)
  return <section className="settings-editor-page skill-page" aria-label="New skill">
    <header className="settings-experience-heading"><h1>New skill</h1></header>
    {accessError ? <ProtectedAccessError error={accessError} />
      : workspaces.isPending ? <LoadingState label="Loading workspaces…" />
        : workspaces.isError ? <ErrorState title="Workspaces could not be loaded" description={workspaces.error.message} onRetry={() => void workspaces.refetch()} />
          : options.length === 0 ? <EmptyState icon="folder" title="No workspace available" />
            : <SkillEditor workspaceOptions={options} initialWorkspace={workspaceId} onSaved={(result) => onSaved(result)} onCancel={onCancel} />}
  </section>
}

function VersionHistory({ workspaceId, skillId, current }: { workspaceId: string; skillId: string; current: string }) {
  const [expanded, setExpanded] = useState(false)
  const historyId = useId()
  const versions = useSkillVersionsQuery(workspaceId, skillId, expanded)
  const [open, setOpen] = useState<string>()
  const exact = useSkillQuery(workspaceId, open ? skillId : '', open)
  return <section className="skill-history" aria-labelledby="skill-history-heading">
    <h2 id="skill-history-heading"><Button variant="ghost" aria-expanded={expanded} aria-controls={historyId}
      leading={<Icon name="down" size={14} style={{ transform: expanded ? undefined : 'rotate(-90deg)' }} />}
      onClick={() => setExpanded(!expanded)}>Version history</Button></h2>
    {/* // InfoHint: Each save creates a version; assigned Agents keep their saved version. */}
    <div id={historyId} hidden={!expanded}>{expanded ? versions.isPending ? <LoadingState label="Loading versions…" rows={2} />
      : versions.isError ? <ErrorState title="Versions could not be loaded" description={versions.error.message} onRetry={() => void versions.refetch()} />
        : <ol className="skill-history-list">{versions.data.items.map((item) => <li key={item.version}>
          <span><strong>Version {item.version}</strong>{item.version === current ? <Badge tone="success">Current</Badge> : null}</span>
          <span className="skill-history-meta">{item.name} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span>
          <Button size="sm" variant="ghost" aria-label={`View version ${item.version}`} onClick={() => setOpen(item.version)}>View</Button>
        </li>)}</ol> : null}</div>
    <Dialog open={Boolean(open)} onOpenChange={(value) => { if (!value) setOpen(undefined) }} size="lg" title={`Version ${open ?? ''}`}
      description={exact.data ? `${exact.data.version.name} · saved ${new Date(exact.data.version.createdAt).toLocaleString()}` : undefined}>
      {exact.isPending ? <LoadingState label="Loading version…" rows={3} />
        : exact.isError ? <ErrorState title="This version could not be loaded" description={exact.error.message} onRetry={() => void exact.refetch()} />
          : <SkillTextPreview text={exact.data.version.instructions} />}
    </Dialog>
  </section>
}

export function SkillDetailPage({ workspaceId, skillId, onCancel }: { workspaceId: string; skillId: string; onCancel(): void }) {
  const query = useSkillQuery(workspaceId, skillId)
  const { name } = useWorkspaceNames()
  const archive = useArchiveSkillMutation()
  const [confirm, setConfirm] = useState(false)
  const [archiveError, setArchiveError] = useState<string>()
  const attempt = useRef(new CommandAttempt<Record<string, unknown>>())
  const accessError = useProtectedAccessError(query)
  if (accessError) return <ProtectedAccessError error={accessError} />
  if (query.isPending) return <LoadingState label="Loading skill…" />
  if (query.isError && !query.data) return query.error && 'code' in query.error && query.error.code === 'SKILL_NOT_FOUND'
    ? <EmptyState icon="warning" title="Skill not found" action={<Button onClick={onCancel}>Back to skills</Button>} />
    : <ErrorState title="This skill could not be loaded" description={query.error.message} onRetry={() => void query.refetch()} />
  const { skill } = query.data
  async function toggleArchive() {
    setArchiveError(undefined)
    try {
      await archive.mutateAsync(attempt.current.input({ workspaceId, skillId, expectedRevision: skill.revision, archived: !skill.archived }) as never)
      attempt.current.succeeded()
      setConfirm(false)
    } catch (failure) {
      attempt.current.failed(failure)
      setArchiveError(errorMessage(failure, 'The change was not saved.'))
    }
  }
  return <section className="settings-editor-page skill-page" aria-label={skill.name}>
    <header className="skills-heading">
      <div className="settings-experience-heading"><h1>{skill.name}</h1>
        <p><Badge>{name(skill.workspaceId)}</Badge> v{skill.version}
          {skill.archived ? <> · <Badge tone="warning">Archived</Badge></> : null}</p></div>
      <Button variant={skill.archived ? 'secondary' : 'ghost'} onClick={() => { setArchiveError(undefined); setConfirm(true) }}>{skill.archived ? 'Restore skill' : 'Archive skill'}</Button>
    </header>
    {query.isError ? <p role="alert" className="skills-inline-error">Could not refresh this skill. Showing the last loaded version. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></p> : null}
    {/* // InfoHint: Archived skills stay assigned but cannot be edited or newly assigned. */}
    {skill.archived ? <p className="n-field-hint">Read only</p> : null}
    <SkillEditor key={`${workspaceId}:${skillId}`} saved={query.data} workspaceOptions={[]} readOnly={skill.archived}
      onSaved={() => undefined} onCancel={onCancel} />
    <SkillUsers workspaceId={workspaceId} skillId={skillId} />
    <VersionHistory workspaceId={workspaceId} skillId={skillId} current={skill.version} />
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} pending={archive.isPending} error={archiveError}
      title={skill.archived ? `Restore ${skill.name}?` : `Archive ${skill.name}?`}
      description={skill.archived ? 'Available in picker' : 'Hidden from picker · Existing assignments kept'}
      confirmLabel={skill.archived ? 'Restore' : 'Archive'} onConfirm={() => void toggleArchive()} />
  </section>
}

function SkillUsers({ workspaceId, skillId }: { workspaceId: string; skillId: string }) {
  const { query, agents } = useSkillAssignments(workspaceId, skillId)
  let assignments = <p className="n-field-hint">No Agents</p>
  if (query.isError) {
    assignments = <p className="skills-inline-error" role="alert">Assignments unavailable
      <Button size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry assignments</Button></p>
  } else if (query.isPending) {
    assignments = <LoadingState label="Loading assignments…" rows={1} />
  } else if (agents.length) {
    assignments = <ul className="skill-users-list">{agents.map((agent) => <li key={agent.id}>
      <strong>{agent.name}</strong>
    </li>)}</ul>
  }
  return <section className="skill-users" aria-labelledby="skill-users-heading">
    <h2 id="skill-users-heading">Assigned Agents</h2>
    {assignments}
    <SkillUsersBanner workspaceId={workspaceId} skillId={skillId} />
  </section>
}

/** After an edit, Agents keep the version they were given; one click moves them and their workflows to this version. */
function SkillUsersBanner({ workspaceId, skillId }: { workspaceId: string; skillId: string }) {
  const usage = useSkillUsageQuery(workspaceId, skillId)
  const update = useUpdateSkillUsersMutation(workspaceId, skillId)
  const commandId = useRef(crypto.randomUUID())
  const failed = update.data?.failed ?? []
  if (usage.isError) return <Alert tone="warning" title="Skill usage could not be loaded."
    action={<Button size="sm" disabled={usage.isFetching} onClick={() => void usage.refetch()}>Try again</Button>}>
    {usage.error.message}
  </Alert>
  if (!usage.data || (!usage.data.agents.length && !usage.data.workflows.length && !failed.length)) return null
  const { agents, workflows } = usage.data
  const count = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'}`
  const users = [agents.length ? count(agents.length, 'Agent') : '', workflows.length ? count(workflows.length, 'workflow') : '']
    .filter(Boolean).join(' and ')
  const verb = agents.length + workflows.length === 1 ? 'uses' : 'use'
  return <div className="skill-user-updates">
    <div className="skill-user-updates-heading">
      <h3>{users ? `${users} still ${verb} an older version` : 'Some updates did not finish'}</h3>
      <Button size="sm" disabled={update.isPending} onClick={() => {
        update.mutate(commandId.current, { onSuccess: () => { commandId.current = crypto.randomUUID() } })
      }}>{update.isPending ? 'Updating…' : `Update to v${usage.data.headVersion}`}</Button>
    </div>
    {agents.length ? <p className="skills-users">{agents.map(agent => `${agent.name} (v${agent.version})`).join(', ')}</p> : null}
    {workflows.length ? <p className="skills-users">{workflows.map(workflow => workflow.name).join(', ')}</p> : null}
    {failed.length ? <p role="alert">{failed.map(item => item.message).join(' ')}</p> : null}
    {update.isError ? <p role="alert">The update could not be sent. Try again.</p> : null}
  </div>
}
