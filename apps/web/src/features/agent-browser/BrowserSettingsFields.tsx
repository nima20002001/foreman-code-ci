import { Button, Checkbox, Select } from '../../shared/ui/nocturne'
import type { BrowserComputerLabel, BrowserProfileCatalog } from '../browser-profiles/types'
import type { NodeBrowserSettings } from './types'

export interface BrowserSettingsFieldsProps {
  value: NodeBrowserSettings | undefined
  onChange(value: NodeBrowserSettings): void
  catalog: BrowserProfileCatalog | undefined
  computer: BrowserComputerLabel | undefined
  disabled?: boolean
  loading?: boolean
  onManageProfiles(): void
}

/** A controlled draft field. Applying/saving belongs to the existing Board form. */
export function BrowserSettingsFields({ value, onChange, catalog, computer, disabled, loading, onManageProfiles }: BrowserSettingsFieldsProps) {
  const enabled = value?.enabled ?? false
  const selected = catalog?.profiles.find(profile => profile.id === value?.profileId)
  const replica = catalog?.replicas.find(item => item.profileId === value?.profileId && item.computerId === computer?.id)
  const profiles = [...(catalog?.profiles ?? [])].sort((left, right) => {
    const available = (id: string) => catalog?.presentReplicas.some(item => item.profileId === id && item.computerId === computer?.id)
    return Number(available(right.id)) - Number(available(left.id)) || left.name.localeCompare(right.name)
  })
  const options = [{ value: '', label: loading ? 'Loading browser profiles…' : 'Choose a browser profile' },
    ...profiles.map(profile => ({ value: profile.id, label: profile.name }))]
  if (value?.profileId && !selected) options.push({ value: value.profileId, label: 'Unavailable profile — choose another profile' })
  const readiness = !computer ? 'Choose or save an execution computer to check this profile.'
    : !computer.online ? 'Computer offline' : !computer.runtimeReady ? 'Browser setup needed'
      : !catalog?.presentReplicas.some(item => item.profileId === value?.profileId && item.computerId === computer.id)
        ? 'Not added here' : replica?.reason ?? 'Ready'
  return <section className="browser-settings-fields" aria-label="Node browser settings">
    <Checkbox label="Browser" checked={enabled} disabled={disabled}
      onChange={event => onChange({ ...value, enabled: event.currentTarget.checked })}
      hint="Applies to the next run. Apply to draft, then Save workflow." />
    {enabled ? <>
      <Select label="Browser profile" value={value?.profileId ?? ''} options={options} disabled={disabled || loading}
        onChange={event => onChange(event.currentTarget.value ? { enabled: true, profileId: event.currentTarget.value } : { enabled: true })}
        error={!value?.profileId ? 'Choose a profile before saving the workflow.' : undefined}
        hint="Uses this profile on the agent’s execution computer. Agents sharing a profile share website sign-ins." />
      <p role="status">{computer ? `Browser on ${computer.name} · ` : ''}{readiness}</p>
      <Button variant="ghost" size="sm" onClick={onManageProfiles}>Manage browser profiles</Button>
    </> : null}
  </section>
}
