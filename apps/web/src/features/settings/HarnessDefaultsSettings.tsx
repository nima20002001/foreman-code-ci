import type { AgentHarness, HarnessDefaults } from '@foreman-code/contracts'
import type { HarnessSettingsSection } from '@foreman-code/contracts/management'
import { Alert, Button, Dialog, ErrorState, LoadingState } from '../../shared/ui/nocturne'
import { useManagedHarnessCatalogQuery } from '../../shared/api/query'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { askOperator } from '../operator-chat/operatorChatStore'
import { SettingsChoice, SettingsOverview } from './SettingsCards'
import { harnessNames, harnessSummary } from './settingsPresentation'
import { ClaudePluginSummary } from './ClaudePluginSummary'
import { CodexPluginManager } from './CodexPluginManager'
import { HarnessMcpManager } from './HarnessMcpManager'
import { OperatorMcpStatus } from './OperatorMcpStatus'
import { ProviderAccountsSettings, type ProviderAccountNavigation } from '../provider-accounts/ProviderAccountsSettings'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'

/** Harnesses this app runs: Codex and Claude. */
const HARNESSES = ['codex', 'claude'] as const
type Harness = typeof HARNESSES[number]

function useProviderDefaults() {
  const catalogQuery = useManagedHarnessCatalogQuery(true)
  const codex = catalogQuery.data?.find((entry) => entry.harness === 'codex')
  const claude = catalogQuery.data?.find((entry) => entry.harness === 'claude')
  const incoming = codex?.defaults.harness === 'codex' && (!claude || (claude.defaults.harness === 'claude' && claude.defaultsRevision === codex.defaultsRevision))
    ? { value: { codex: codex.defaults, ...(claude?.defaults.harness === 'claude' ? { claude: claude.defaults } : {}) } as HarnessDefaults, revision: codex.defaultsRevision }
    : undefined
  return { incoming, query: catalogQuery }
}

function ProviderCard({ harness, value, revision, readiness, onOpen, accountSelection, onAccountSelect,
  accountTarget, onAccountTargetChange }: {
  harness: Harness; value?: HarnessDefaults | undefined; revision?: number | undefined; readiness: string
  onOpen(section: 'connections' | 'plugins'): void
  accountSelection?: ProviderAccountNavigation | undefined
  onAccountSelect?: ((selection: ProviderAccountNavigation | undefined) => void) | undefined
  accountTarget?: DeviceProvisioningTarget | undefined
  onAccountTargetChange?: ((target: DeviceProvisioningTarget) => void) | undefined
}) {
  const name = harnessNames[harness]
  const preset = value?.[harness]
  const summary = [...(preset ? harnessSummary(preset).filter((item) => item.label !== 'Harness') : [{ label: 'Preset', value: 'Not configured' }]),
    { label: 'Status', value: readiness }]
  return <SettingsChoice icon="settings" title={name} summary={summary}
    onSelect={() => askOperator(`Change the ${name} preset: `, { send: false })}
    footer={<>
      {value && revision !== undefined ? <OperatorMcpStatus harness={harness} defaults={value} revision={revision} /> : null}
      <span className="settings-choice-links">
        {harness === 'codex' ? <>
          <Button size="sm" variant="ghost" onClick={() => onOpen('connections')}>Connections</Button>
        </> : null}
        <Button size="sm" variant="ghost" onClick={() => onOpen('plugins')}>Plugins</Button>
      </span>
      <ProviderAccountsSettings provider={harness} selection={accountSelection} onSelect={onAccountSelect}
        target={accountTarget} onTargetChange={onAccountTargetChange} />
    </>} />
}

/** Harness presets and plugin changes are managed by the Operator. */
export function HarnessDefaultsSettings({ selectedHarness, section, onOpen, accountSelection, onAccountSelect,
  accountTarget, onAccountTargetChange }: {
  selectedHarness?: AgentHarness | undefined; section?: HarnessSettingsSection | undefined
  accountSelection?: ProviderAccountNavigation | undefined
  onAccountSelect?: ((selection: ProviderAccountNavigation | undefined) => void) | undefined
  accountTarget?: DeviceProvisioningTarget | undefined
  onAccountTargetChange?: ((target: DeviceProvisioningTarget) => void) | undefined
  onOpen?(next: { harness: Harness; section: 'connections' | 'plugins' } | undefined): void
}) {
  const { incoming, query } = useProviderDefaults()
  const accessError = useProtectedAccessError(query)
  let dialog: 'plugins' | 'connections' | undefined
  if (section === 'plugins' && (selectedHarness === 'codex' || selectedHarness === 'claude')) dialog = 'plugins'
  if (section === 'connections' && selectedHarness === 'codex') dialog = 'connections'
  const dialogName = selectedHarness === 'claude' ? 'Claude' : 'Codex'
  const readiness = (harness: Harness) => {
    const entry = query.data?.find((item) => item.harness === harness)
    return !entry ? 'Not configured' : entry.discoveryError ? entry.discoveryError.message : entry.capability ? 'Ready' : 'Checking…'
  }
  let overview
  if (accessError || (!incoming && (query.isError || query.isSuccess))) {
    overview = <ErrorState title="Harness defaults are unavailable"
      description={accessError?.message ?? query.error?.message ?? 'The server returned an incomplete provider catalog.'}
      onRetry={() => void query.refetch()} />
  } else if (!incoming) {
    overview = <LoadingState label="Loading harness defaults…" />
  } else {
    overview = query.isError ? <Alert tone="warning" title="Harness defaults couldn't update"
      action={<Button size="sm" onClick={() => void query.refetch()}>Retry defaults</Button>}>Showing the last saved presets.</Alert> : null
  }
  return <>
    {overview}
    <SettingsOverview title="Harnesses">
      {HARNESSES.map(harness => <ProviderCard key={harness} harness={harness} value={incoming?.value}
        revision={incoming?.revision} readiness={readiness(harness)} accountSelection={accountSelection}
        accountTarget={accountTarget} onAccountTargetChange={onAccountTargetChange}
        onAccountSelect={onAccountSelect} onOpen={next => onOpen?.({ harness, section: next })} />)}
    </SettingsOverview>
    <Dialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) onOpen?.(undefined) }} size="lg"
      title={dialog === 'plugins' ? `${dialogName} plugins` : 'Codex connections'}>
      {dialog === 'plugins' && selectedHarness === 'claude' ? <ClaudePluginSummary accessUnavailable={Boolean(accessError)}
        onClose={() => onOpen?.(undefined)} /> : null}
      {dialog === 'plugins' && selectedHarness === 'codex' ? <CodexPluginManager accessUnavailable={Boolean(accessError)} /> : null}
      {dialog === 'connections' ? <HarnessMcpManager harness="codex" accessUnavailable={Boolean(accessError)} /> : null}
    </Dialog>
  </>
}
