import { useMemo, useState } from 'react'
import type { AssignedSkill } from '@foreman-code/contracts'
import type { SkillSummary } from '@foreman-code/contracts/management'
import { Alert, Badge, Button, Checkbox, EmptyState, Icon, IconButton, LoadingState, SearchField } from '../../shared/ui/nocturne'
import { SkillTextPreview } from './SkillEditor'
import { useSkillQuery, useSkillCatalog } from './skillsApi'
import { useWorkspaceNames } from './workspaceNames'
import './skills.css'

function SkillBody({ workspaceId, skill }: { workspaceId: string; skill: SkillSummary }) {
  const query = useSkillQuery(workspaceId, skill.skillId, skill.version)
  if (query.isPending) return <LoadingState label="Loading instructions…" rows={2} />
  if (query.isError) return <p className="n-field-error" role="alert">Instructions could not be loaded. {query.error.message}</p>
  return <SkillTextPreview text={query.data.version.instructions} />
}

type SkillRef = AssignedSkill & { workspaceId?: string | undefined }
const keyOf = (skill: { workspaceId?: string | undefined; skillId: string }, fallback?: string) => `${skill.workspaceId ?? fallback ?? ''}:${skill.skillId}`

function SkillPicker({ workspaceId, catalog, selected, onAdd, onClose, workspaceName }: {
  workspaceId?: string | undefined; catalog: SkillSummary[]; selected: readonly SkillRef[]; onAdd(skills: SkillSummary[]): void; onClose(): void
  workspaceName?: ((id: string) => string) | undefined
}) {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const find = (key: string) => catalog.find((skill) => keyOf(skill) === key)
  const [preview, setPreview] = useState<string>()
  const available = catalog.filter((skill) => !skill.archived && !selected.some((item) => keyOf(item, workspaceId) === keyOf(skill)))
  const needle = query.trim().toLowerCase()
  const shown = available.filter((skill) => !needle || skill.name.toLowerCase().includes(needle) || skill.description?.toLowerCase().includes(needle))
  const previewed = preview ? find(preview) : undefined
  // Inline, not a nested modal: the board Agent editor is itself a dismissable surface.
  return <section className="agent-skill-picker" aria-label="Add skills" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
      {/* // InfoHint: Skills follow selection order and keep their assigned version. */}
      <SearchField label="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
      {available.length === 0 ? <EmptyState icon="code" title="No more skills to add" />
        : shown.length === 0 ? <p className="n-field-hint" role="status">No skills match “{query}”.</p>
          : <ul className="agent-skill-options" aria-label="Available skills">{shown.map((skill) => {
            const key = keyOf(skill), index = chosen.indexOf(key)
            return <li key={key}>
              <Checkbox label={`${skill.name}${index >= 0 ? ` · ${index + 1}` : ''}`} checked={index >= 0}
                hint={[workspaceName?.(skill.workspaceId), skill.description, `Version ${skill.version}`].filter(Boolean).join(' · ')}
                onChange={(event) => setChosen((current) => event.target.checked ? [...current, key] : current.filter((id) => id !== key))} />
            <Button size="sm" variant="ghost" aria-label={`${preview === key ? 'Hide preview of' : 'Preview'} ${skill.name}`} aria-pressed={preview === key}
              onClick={() => setPreview(preview === key ? undefined : key)}>{preview === key ? 'Hide' : 'Preview'}</Button></li>
          })}</ul>}
      {previewed ? <section aria-label={`${previewed.name} instructions`}><SkillBody workspaceId={previewed.workspaceId} skill={previewed} /></section> : null}
      <div className="n-actions"><Button size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!chosen.length} onClick={() => onAdd(chosen.map((key) => find(key)!))}>
          {chosen.length ? `Add ${chosen.length} ${chosen.length === 1 ? 'skill' : 'skills'}` : 'Add skills'}</Button></div>
  </section>
}

/** Ordered, versioned skill references. A board Agent uses its workspace's skills; the application-level
 * Operator (acrossWorkspaces) may use skills from any workspace the user can read. Loading or errors never
 * change the selection. */
export function AgentSkillsField<T extends SkillRef>({ workspaceId, acrossWorkspaces = false, value, onChange, disabled = false }: {
  workspaceId?: string | undefined; acrossWorkspaces?: boolean; value: readonly T[]; onChange(next: T[]): void; disabled?: boolean
}) {
  const catalog = useSkillCatalog(acrossWorkspaces ? undefined : workspaceId, acrossWorkspaces || Boolean(workspaceId))
  const names = useWorkspaceNames(acrossWorkspaces)
  const workspaceName = acrossWorkspaces ? names.name : undefined
  const ready = acrossWorkspaces || Boolean(workspaceId)
  const [picking, setPicking] = useState(false)
  const skills = useMemo(() => catalog.data?.items ?? [], [catalog.data])
  const move = (index: number, by: number) => {
    const next = [...value]; const [item] = next.splice(index, 1); next.splice(index + by, 0, item!); onChange(next)
  }
  return <div className="agent-skills" role="group" aria-labelledby="agent-skills-label">
    <div className="agent-skills-head">
      <span id="agent-skills-label">Skills</span>
      <span className="agent-skill-actions">
        <a className="n-button n-button--ghost n-button--sm" href={workspaceId && !acrossWorkspaces ? `/settings/skills?workspace=${encodeURIComponent(workspaceId)}` : '/settings/skills'} target="_blank" rel="noreferrer">Manage</a>
        <Button size="sm" variant="secondary" disabled={disabled || picking || !ready || !catalog.data} leading={<Icon name="plus" size={13} />} onClick={() => setPicking(true)}>Add</Button>
      </span>
    </div>
    {catalog.isError ? <Alert tone="warning" title="Skills could not be loaded. Your selection is unchanged."
      action={<Button size="sm" onClick={() => void catalog.refetch()}>Try again</Button>} /> : null}
    {value.length === 0 ? <p className="n-field-hint">{catalog.isPending && ready ? 'Loading skills…' : 'No skills assigned'}</p>
      : <ol className="agent-skills-list" aria-label="Assigned skills, in the order the Agent receives them">{value.map((item, index) => {
        const skill = skills.find((entry) => keyOf(entry) === keyOf(item, workspaceId))
        const label = skill?.name ?? item.skillId
        return <li key={keyOf(item, workspaceId)}>
          <span className="agent-skill-name"><strong>{label}</strong>
            <span>{workspaceName && item.workspaceId ? `${workspaceName(item.workspaceId)} · ` : ''}Version {item.version}
              {skill?.archived ? <> · <Badge tone="warning">Archived</Badge></> : !catalog.isPending && !catalog.isError && !skill ? <> · <Badge tone="warning">Unavailable</Badge></> : null}</span></span>
          <span className="agent-skill-actions">
            {skill && !skill.archived && skill.version !== item.version ? <Button size="sm" variant="ghost" disabled={disabled}
              onClick={() => onChange(value.map((entry) => entry === item ? { ...entry, version: skill.version } : entry))}>
              Use version {skill.version}</Button> : null}
            <IconButton size="sm" variant="ghost" label={`Move ${label} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}>
              <Icon name="down" size={13} style={{ transform: 'rotate(180deg)' }} /></IconButton>
            <IconButton size="sm" variant="ghost" label={`Move ${label} down`} disabled={disabled || index === value.length - 1} onClick={() => move(index, 1)}>
              <Icon name="down" size={13} /></IconButton>
            <IconButton size="sm" variant="ghost" label={`Remove ${label}`} disabled={disabled} onClick={() => onChange(value.filter((entry) => entry !== item))}>
              <Icon name="close" size={13} /></IconButton>
          </span>
        </li>
      })}</ol>}
    {picking && ready ? <SkillPicker workspaceId={acrossWorkspaces ? undefined : workspaceId} workspaceName={workspaceName} catalog={skills} selected={value} onClose={() => setPicking(false)}
      onAdd={(added) => { onChange([...value, ...added.map((skill) => ({ ...(acrossWorkspaces ? { workspaceId: skill.workspaceId } : {}), skillId: skill.skillId, version: skill.version }) as T)]); setPicking(false) }} /> : null}
  </div>
}
