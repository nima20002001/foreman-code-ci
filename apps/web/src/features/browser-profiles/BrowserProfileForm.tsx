import { useState } from 'react'
import { Button, Dialog, Select, TextField } from '../../shared/ui/nocturne'
import type { BrowserComputerLabel, BrowserProfile } from './types'

export function BrowserProfileForm({ profile, computerId, computers, profiles, pending, error, unresolved, onSave, onAddExisting, onRetry, onClose }: {
  profile: BrowserProfile | null; computerId: string; computers: readonly BrowserComputerLabel[]
  profiles: readonly BrowserProfile[]
  pending: boolean; error: string | null; unresolved: boolean
  onSave(name: string, computerId: string, distribution: BrowserProfile['distribution']): void
  onAddExisting(profileId: string, computerId: string): void
  onRetry(): void; onClose(): void
}) {
  const [name, setName] = useState(profile?.name ?? '')
  const [computer, setComputer] = useState(profile?.sourceComputerId ?? computerId)
  const [distribution, setDistribution] = useState<BrowserProfile['distribution']>(profile?.distribution ?? 'shared')
  const [mode, setMode] = useState('new')
  const [existingId, setExistingId] = useState('')
  const existing = profiles.filter(value => value.distribution === 'shared' || value.sourceComputerId === computer)
  const useExisting = !profile && mode === 'existing'
  const options = computers.map(value => ({ value: value.id, label: `${value.name}${value.online ? '' : ' · Offline'}` }))
  if (computer && !options.some(value => value.value === computer)) options.push({ value: computer, label: 'Unavailable source computer' })
  return <Dialog open title={profile ? 'Edit browser profile' : 'Add browser profile'} busy={pending || unresolved}
    onOpenChange={open => { if (!open) onClose() }}>
    <form className="browser-profile-form" onSubmit={event => {
      event.preventDefault()
      if (unresolved || pending) return
      if (useExisting) onAddExisting(existingId, computer)
      else onSave(name, computer, distribution)
    }}>
      {!profile ? <Select label="Profile choice" value={mode} disabled={pending || unresolved}
        options={[{ value: 'new', label: 'Create a new profile' }, { value: 'existing', label: 'Add an existing profile' }]}
        onChange={event => setMode(event.currentTarget.value)} /> : null}
      {useExisting ? <Select label="Existing profile" value={existingId} disabled={pending || unresolved}
        options={[{ value: '', label: 'Choose an existing profile' }, ...existing.map(value => ({ value: value.id, label: value.name }))]}
        onChange={event => setExistingId(event.currentTarget.value)} /> : <TextField label="Profile name" value={name} maxLength={120} required disabled={pending || unresolved}
        onChange={event => setName(event.currentTarget.value)} />
      }
      <Select label={profile ? 'Source computer' : 'Computer'} value={computer} options={options} disabled={pending || unresolved}
        onChange={event => setComputer(event.currentTarget.value)} />
      {!useExisting ? <Select label="Profile distribution" value={distribution} disabled={pending || unresolved}
        options={[{ value: 'shared', label: 'Shared — can sync to other computers' }, { value: 'local_only', label: 'Local only' }]}
        onChange={event => setDistribution(event.currentTarget.value === 'local_only' ? 'local_only' : 'shared')} /> : null}
      <p>Agents using the same profile share website sign-ins. Applying a snapshot does not guarantee a website will accept a sign-in.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="browser-profile-actions">
        <Button type="submit" disabled={pending || unresolved || !computer || (useExisting ? !existing.some(value => value.id === existingId) : !name.trim())}>
          {pending ? 'Saving…' : profile ? 'Save profile' : useExisting ? 'Add existing profile' : 'Create profile'}</Button>
        {unresolved ? <Button disabled={pending} onClick={onRetry}>Check original request</Button> : null}
        <Button variant="ghost" disabled={pending || unresolved} onClick={onClose}>Cancel</Button>
      </div>
    </form>
  </Dialog>
}
