import type { ComputerAccount, ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { ComputerConnections, MaintenanceStatus, MaintenanceTask, WorkerBundleReadiness }
  from '@foreman-code/contracts/computer-maintenance'
import { humanizeMaintenanceText, newestTaskPerKind, taskLabel } from './maintenanceText'

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
export type ChipId = 'codex' | 'claude' | 'github' | 'mcp' | 'update'
export interface StatusChip {
  id: ChipId; label: string
  /** Stable machine state, e.g. not-installed, signed-out, ready, missing, available, running, failed. */
  state: string
  text: string; tone: Tone; detail: string
  /** Offer the sign-in request to the Operator. */
  signIn?: string
}

const UPDATE_KINDS = new Set(['update-harnesses', 'update-system', 'update-worker'])
const MCP_STATE_TEXT = { installed: 'installed', missing: 'not set up', disabled: 'disabled' } as const

function toolChip(id: 'codex' | 'claude' | 'github', label: string, account: ComputerAccount | undefined,
  harness: MaintenanceStatus['harnesses'][number] | undefined): StatusChip {
  const installed = harness ? harness.installed : account?.installed
  const version = harness?.version ? ` ${harness.version}` : ''
  if (installed === undefined) return { id, label, state: 'unknown', text: 'unknown', tone: 'neutral', detail: `${label} state is not available yet.` }
  if (!installed) return { id, label, state: 'not-installed', text: 'not installed', tone: 'danger',
    detail: id === 'github' ? 'GitHub CLI is not installed on this computer.' : `${label} is not installed. Update installs it.` }
  if (account?.signedIn === false) return { id, label, state: 'signed-out', text: 'signed out', tone: 'warning',
    detail: `${label}${version} is installed but not signed in.`, signIn: label }
  if (account?.signedIn == null) return { id, label, state: 'login-unknown', text: 'sign-in unknown', tone: 'neutral',
    detail: `${label}${version} is installed; its sign-in state could not be read.` }
  return { id, label, state: 'signed-in', text: 'signed in', tone: 'success',
    detail: `${label}${version} is installed and signed in${account.account ? ` as ${account.account}` : ''}.` }
}

function mcpChip(connections: ComputerConnections | undefined, installed: { codex: boolean | undefined; claude: boolean | undefined }): StatusChip {
  const label = 'Foreman MCP'
  const harnesses = (['codex', 'claude'] as const).filter(harness => installed[harness] !== false)
  const states = harnesses.map(harness => [harness, connections?.mcp[harness] ?? null] as const)
  if (!connections || states.every(([, state]) => state === null)) {
    return { id: 'mcp', label, state: 'unknown', text: 'unknown', tone: 'neutral',
      detail: harnesses.length ? 'Foreman MCP state could not be read.' : 'No harness is installed.' }
  }
  const name = (harness: string) => harness === 'codex' ? 'Codex' : 'Claude'
  const describe = ([harness, state]: readonly ['codex' | 'claude', string | null]) =>
    `${name(harness)} ${state === null ? 'unknown' : state in MCP_STATE_TEXT ? MCP_STATE_TEXT[state as keyof typeof MCP_STATE_TEXT] : 'needs repair'}`
  const detail = `${states.map(describe).join(', ')}.`
  if (states.every(([, state]) => state === 'installed')) return { id: 'mcp', label, state: 'installed', text: 'installed', tone: 'success', detail }
  const bad = states.filter(([, state]) => state !== 'installed')
  const missingOnly = bad.every(([, state]) => state === 'missing')
  const text = !missingOnly ? 'needs repair'
    : states.length > 1 && bad.length === 1 ? `${name(bad[0]![0])} not set up` : 'not set up'
  return { id: 'mcp', label, state: missingOnly ? 'missing' : 'repair', text, tone: 'warning', detail }
}

export const workerBehind = (status: MaintenanceStatus, readiness: WorkerBundleReadiness | undefined) => {
  const worker = status.worker
  return Boolean(worker && (worker.state === 'failed' || worker.state === 'rolled-back'
    || readiness?.code === 'WORKER_VERSION_SKEW'
    || (worker.state === 'current' && worker.targetVersion && worker.targetVersion !== worker.currentVersion)))
}

function updateChip({ status, readiness, starting }: {
  status: MaintenanceStatus | null | undefined; readiness: WorkerBundleReadiness | undefined; starting: boolean
}): StatusChip {
  const label = 'Update'
  const tasks = newestTaskPerKind(status?.tasks ?? []).filter(task => UPDATE_KINDS.has(task.kind))
  const running = tasks.find(task => task.state === 'running')
  const worker = status?.worker
  const workerUpdating = worker !== undefined && !['current', 'failed', 'rolled-back'].includes(worker.state)
  if (starting || running || workerUpdating) {
    return { id: 'update', label, state: 'running', text: 'updating…', tone: 'info',
      detail: running ? `${taskLabel(running.kind)} is running.` : workerUpdating ? 'The Worker is updating.' : 'Starting the update.' }
  }
  if (!status) return { id: 'update', label, state: 'unknown', text: 'unknown', tone: 'neutral', detail: 'Update state is not available yet.' }
  const failedTask: MaintenanceTask | undefined = tasks.find(task => task.state === 'failed')
  const failedWorker = worker?.state === 'failed' || worker?.state === 'rolled-back'
  if (failedTask || failedWorker) {
    const raw = failedTask?.summary ?? worker?.lastError ?? 'Worker update failed.'
    const { text, raw: code } = humanizeMaintenanceText(raw)
    return { id: 'update', label, state: 'failed', text: 'update failed', tone: 'danger',
      detail: `${failedTask ? taskLabel(failedTask.kind) : 'Worker update'}: ${text}${code ? ` (${code})` : ''}` }
  }
  const items: string[] = []
  const packages = status.system.packageUpdates ?? 0
  if (packages > 0) items.push(`${packages} OS package${packages === 1 ? '' : 's'}`)
  for (const harness of status.harnesses) {
    if (!harness.installed) {
      items.push(`Install ${harness.harness === 'codex' ? 'Codex' : 'Claude'}`)
    } else if (harness.latest && harness.version !== harness.latest) {
      items.push(`${harness.harness === 'codex' ? 'Codex' : 'Claude'} ${harness.version ?? '?'} → ${harness.latest}`)
    }
  }
  if (workerBehind(status, readiness)) items.push(`Worker ${worker?.currentVersion ?? '?'} → ${worker?.targetVersion ?? 'latest'}`)
  if (items.length) return { id: 'update', label, state: 'available', text: `${items.length} update${items.length === 1 ? '' : 's'}`,
    tone: 'warning', detail: `Available: ${items.join(', ')}.` }
  return { id: 'update', label, state: 'current', text: 'up to date', tone: 'success',
    detail: status.system.packageUpdates === null ? 'Harnesses and Worker are current; OS updates could not be verified.' : 'Everything is up to date.' }
}

/** Codex, Claude, GitHub, Foreman MCP and Updates for one computer, each with one state, color and explanation. */
export function deriveStatusChips({ accounts, connections, status, readiness, starting }: {
  accounts: ComputerAccounts | null | undefined; connections: ComputerConnections | undefined
  status: MaintenanceStatus | null | undefined; readiness: WorkerBundleReadiness | undefined; starting: boolean
}): StatusChip[] {
  const account = (tool: ComputerAccount['tool']) => accounts?.accounts.find(value => value.tool === tool)
  const harness = (name: 'codex' | 'claude') => status?.harnesses.find(entry => entry.harness === name)
  const codex = toolChip('codex', 'Codex', account('codex'), harness('codex'))
  const claude = toolChip('claude', 'Claude', account('claude'), harness('claude'))
  const installed = (chip: StatusChip) => chip.state === 'unknown' ? undefined : chip.state !== 'not-installed'
  return [codex, claude, toolChip('github', 'GitHub', account('github'), undefined),
    mcpChip(connections, { codex: installed(codex), claude: installed(claude) }),
    updateChip({ status, readiness, starting })]
}
