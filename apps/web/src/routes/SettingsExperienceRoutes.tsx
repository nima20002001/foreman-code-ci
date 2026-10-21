import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AgentDefaultsSettings } from '../features/settings/AgentDefaultsSettings'
import { ComputerSettings } from '../features/settings/ComputerSettings'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { Alert } from '../shared/ui/nocturne'
import { HarnessDefaultsSettings } from '../features/settings/HarnessDefaultsSettings'
import { WorkspaceDefaultsSettings } from '../features/settings/WorkspaceDefaultsSettings'
import { GeneralSettings } from '../features/settings/GeneralSettings'
import { BugsSettings } from '../features/bug-reports/BugsSettings'
import { PromptSettings } from '../features/settings/PromptSettings'
import { WorkspaceShell } from '../shared/ui/WorkspaceShell'
import { SkillsLibrary } from '../features/skills/SkillsLibrary'
import { NewSkillPage, SkillDetailPage } from '../features/skills/SkillPages'
import '../features/settings/settingsExperience.css'

function SettingsShell({ children }: { children: ReactNode }) {
  return <WorkspaceShell workspaceId="workspace-1" activeGlobalSection="settings" slots={{ main:
    <div className="settings-page settings-experience">
      {children}
    </div>,
  }} />
}
export function AgentSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/agents' })
  const navigate = useNavigate({ from: '/settings/agents' })
  return <SettingsShell><AgentDefaultsSettings selectedRole={search.role}
    onOpen={role => void navigate({ search: role ? { role } : {} })} /></SettingsShell>
}
export function SystemPromptSettingsRouteEntry() {
  return <SettingsShell><PromptSettings page="system-prompt" /></SettingsShell>
}
export function HarnessSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  return <SettingsShell><HarnessDefaultsSettings selectedHarness={search.harness} section={search.section}
    accountTarget={search.accountTarget}
    accountSelection={search.accountProvider && search.accountId ? {
      provider: search.accountProvider, accountId: search.accountId,
      ...(search.operationId ? { operationId: search.operationId } : {}),
      ...(search.accountTarget ? { target: search.accountTarget } : {}),
    } : undefined}
    onAccountSelect={selection => void navigate({ search: {
      ...(search.harness ? { harness: search.harness } : {}),
      ...(search.section ? { section: search.section } : {}),
      ...(search.accountTarget ? { accountTarget: search.accountTarget } : {}),
      ...(selection ? { accountProvider: selection.provider, accountId: selection.accountId,
        ...(selection.target ? { accountTarget: selection.target } : {}),
        ...(selection.operationId ? { operationId: selection.operationId } : {}) } : {}),
    } })}
    onAccountTargetChange={target => void navigate({ search: {
      ...(search.harness ? { harness: search.harness } : {}),
      ...(search.section ? { section: search.section } : {}), accountTarget: target,
    } })}
    onOpen={(next) => void navigate({ search: { ...next,
      ...(search.accountTarget ? { accountTarget: search.accountTarget } : {}),
    } })} /></SettingsShell>
}
export function SkillsSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/skills' })
  const navigate = useNavigate({ from: '/settings/skills' })
  return <SettingsShell><SkillsLibrary search={search} onSearchChange={(next) => void navigate({ search: next, replace: true })} /></SettingsShell>
}
export function NewSkillRouteEntry() {
  const search = useSearch({ from: '/settings/skills/new' })
  const navigate = useNavigate()
  return <SettingsShell><NewSkillPage workspaceId={search.workspace}
    onSaved={(result) => void navigate({ to: '/settings/skills/$workspaceId/$skillId', params: { workspaceId: result.skill.workspaceId, skillId: result.skill.skillId }, replace: true })}
    onCancel={() => void navigate({ to: '/settings/skills', search: search.workspace ? { workspace: search.workspace } : {} })} /></SettingsShell>
}
export function SkillDetailRouteEntry() {
  const params = useParams({ from: '/settings/skills/$workspaceId/$skillId' })
  const navigate = useNavigate()
  return <SettingsShell><SkillDetailPage key={`${params.workspaceId}:${params.skillId}`} workspaceId={params.workspaceId} skillId={params.skillId}
    onCancel={() => void navigate({ to: '/settings/skills' })} /></SettingsShell>
}
export function WorkspaceDefaultsSettingsRouteEntry() {
  return <SettingsShell><WorkspaceDefaultsSettings /></SettingsShell>
}
export function GeneralSettingsRouteEntry() {
  return <SettingsShell><GeneralSettings /></SettingsShell>
}
export function BugsSettingsRouteEntry() {
  const search = useSearch({ from: '/settings/bugs' })
  const navigate = useNavigate({ from: '/settings/bugs' })
  return <SettingsShell><BugsSettings search={search}
    onSearchChange={next => void navigate({ search: next })} /></SettingsShell>
}

export function ComputersSettingsRouteEntry() {
  const navigate = useNavigate()
  return <SettingsShell><ComputerSettings onSelectComputer={(deviceId) => void navigate({ to: '/settings/computers/$deviceId', params: { deviceId } })} /></SettingsShell>
}
export function ComputerDetailsSettingsRouteEntry() {
  const params = useParams({ strict: false })
  const device = DeviceRegistrationSchema.shape.deviceId.safeParse(params.deviceId)
  return <SettingsShell>
    {device.success ? <ComputerSettings key={device.data} deviceId={device.data} /> : <Alert tone="danger" title="The computer address is invalid." />}
  </SettingsShell>
}
