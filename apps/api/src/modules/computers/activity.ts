import type pg from 'pg'
import { CiRunRecordSchema, type ReadObservation } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import { z } from 'zod'
import {
  COMPUTER_ACTIVITY_LIMIT, ComputerActivityListSchema, computerDisplayName, ComputerAgentActivitySchema, ComputerJobActivitySchema,
  type CloudCiActivity, type ComputerActivity, type ComputerActivityList,
} from '@foreman-code/contracts/computer-activity'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { DeviceProvisioningTargetSchema, sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { DevicePresence } from '@foreman-code/contracts/device-connection'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { buildComputerKey } from '../settings/buildComputers.js'
import { computerNameKey, readComputerNames, renameComputer } from './names.js'
import { cloudCiId } from '../ci-host/cloudProviders.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type { CircleCreditsReader } from '../ci-host/circleCredits.js'
import type { CircleSchedulingReading } from '../ci-host/circleStandby.js'

const jobRow = z.object({ target: DeviceProvisioningTargetSchema, activity: ComputerJobActivitySchema })
const agentRow = z.object({ target: DeviceProvisioningTargetSchema, activity: ComputerAgentActivitySchema })

/** A cloud CI service as Main's CI dispatcher sees it. */
export interface CloudCiService {
  readonly provider: { readonly id: CloudCiActivity['provider']; readonly label: string; readonly slots: number
    readonly circleAccountId?: string | undefined; readonly recoveryOnly?: boolean | undefined
    readonly account?: { readonly owner: string; registered?: boolean } | undefined }
  readonly readinessObservation?: ReadObservation | undefined
  ready(): Promise<boolean>
  schedulingReading?(): Promise<CircleSchedulingReading | undefined>
}

export class ComputerActivityService {
  private readonly cloudReadiness = new Map<CloudCiService, { ready: boolean; pending: boolean }>()
  constructor(
    private readonly pool: pg.Pool,
    private readonly mainId: string,
    private readonly presence: (deviceId: string) => DevicePresence | null,
    private readonly commands: PostgresCommandCoordinator,
    private readonly clouds: readonly CloudCiService[] = [],
    private readonly credits?: CircleCreditsReader,
  ) {}

  rename(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    return renameComputer(this.pool, this.commands, this.mainId, principal, source, raw)
  }

  async list(principal: ManagementPrincipal, source: 'http' | 'mcp' = 'http'): Promise<ComputerActivityList> {
    try {
      requireAuthorization(principal, 'settings:read')
    } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'computer_activity_list', this.mainId)
      throw error
    }
    this.refreshCloudReadiness()
    return withTransaction(this.pool, async (sql) => {
      const live = await readLiveManagementPrincipal(sql, principal.id)
      requireAuthorization(live, 'settings:read')
      const registrations = await sql.query<{ record: unknown }>(`select record from device_registrations
        where main_id=$1 and record->>'status'='paired' order by id limit 101`, [this.mainId])
      const names = await readComputerNames(sql, this.mainId)
      const computers: ComputerActivity[] = [{
        target: { hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId,
          keyRevision: null, authorizationRevision: null },
        name: names.get(computerNameKey(this.mainId)) ?? computerDisplayName({ kind: 'main' }), online: true, jobs: [], agents: [],
      }]
      for (const row of registrations.rows.slice(0, 100)) {
        const registration = DeviceRegistrationSchema.parse(row.record)
        const observed = this.presence(registration.deviceId)
        const binding = observed?.binding
        const online = observed?.phase === 'ready' && binding?.mainId === this.mainId
          && binding.workerInstallationId === registration.workerInstallationId
          && binding.keyRevision === registration.keyRevision
          && binding.authorizationRevision === registration.authorizationRevision
        computers.push({ target: { hostRef: { kind: 'device', mainId: this.mainId, deviceId: registration.deviceId },
          applicationInstallationId: registration.workerInstallationId, keyRevision: registration.keyRevision,
          authorizationRevision: registration.authorizationRevision },
        name: names.get(computerNameKey(this.mainId, registration.deviceId))
          ?? computerDisplayName({ kind: 'device', deviceId: registration.deviceId }), online, jobs: [], agents: [] })
      }
      const byHost = new Map(computers.map(computer => [buildComputerKey(computer.target), computer]))
      const jobs = await readJobs(sql, this.mainId)
      const ciJobs = await readCiJobs(sql, this.mainId, computers)
      const jobActivities = [...jobs.rows, ...ciJobs]
      const agents = await readAgents(sql, this.mainId)
      for (const row of jobActivities.slice(0, COMPUTER_ACTIVITY_LIMIT)) {
        const { target, activity } = jobRow.parse(row)
        if (isAuthorized(principal, 'jobs:read', activity) && isAuthorized(live, 'jobs:read', activity)) {
          const computer = byHost.get(buildComputerKey(target))
          if (computer && sameDeviceProvisioningTarget(computer.target, target)) computer.jobs.push(activity)
        }
      }
      for (const row of agents.rows.slice(0, COMPUTER_ACTIVITY_LIMIT)) {
        const { target, activity } = agentRow.parse(row)
        if (isAuthorized(principal, 'runs:read', activity) && isAuthorized(live, 'runs:read', activity)) {
          const computer = byHost.get(buildComputerKey(target))
          if (computer && sameDeviceProvisioningTarget(computer.target, target)) computer.agents.push(activity)
        }
      }
      const cloud = await readCloud(sql, this.mainId, await Promise.all(this.clouds.map(async service => ({
        provider: service.provider, ready: this.cloudReadiness.get(service)?.ready ?? false,
        observation: service.readinessObservation,
        scheduling: await service.schedulingReading?.(),
      }))), this.credits)
      const truncated = registrations.rows.length > 100 || jobActivities.length > COMPUTER_ACTIVITY_LIMIT
        || agents.rows.length > COMPUTER_ACTIVITY_LIMIT
      const latest = await readLiveManagementPrincipal(sql, principal.id)
      requireAuthorization(latest, 'settings:read')
      // Recheck scoped grants before returning names read during this request.
      for (const computer of computers) {
        computer.jobs = computer.jobs.filter(job => isAuthorized(latest, 'jobs:read', job))
        computer.agents = computer.agents.filter(agent => isAuthorized(latest, 'runs:read', agent))
      }
      const activityComplete = !truncated && [principal, live, latest].every(caller =>
        isAuthorized(caller, 'jobs:read') && isAuthorized(caller, 'runs:read'))
      return ComputerActivityListSchema.parse({ mainId: this.mainId, computers, cloud, truncated, activityComplete })
    })
  }

  private refreshCloudReadiness(): void {
    for (const cloud of this.clouds) {
      let state = this.cloudReadiness.get(cloud)
      if (state?.pending) continue
      if (!state) {
        state = { ready: false, pending: false }
        this.cloudReadiness.set(cloud, state)
      }
      const observation = state
      observation.pending = true
      void cloud.ready().then(ready => {
        observation.ready = ready
      }, error => {
        logIgnoredError('jobs', 'read cloud activity readiness', error, { provider: cloud.provider.id })
      }).finally(() => { observation.pending = false })
    }
  }
}

async function readCloud(sql: pg.PoolClient, mainId: string, clouds: readonly {
  provider: CloudCiService['provider']; ready: boolean; observation: ReadObservation | undefined
  scheduling?: CircleSchedulingReading | undefined
}[], credits?: CircleCreditsReader) {
  if (!clouds.length) return []
  const counts = await sql.query<{ provider: string; running: number }>(`select split_part(host_key, ':', 3) as provider,
    count(*)::int as running from ci_runs where state in ('starting','running') and host_key like $1
    group by 1`, [`${mainId}:cloud:%`])
  const running = new Map(counts.rows.map(row => [row.provider, row.running]))
  const listed: CloudCiActivity[] = []
  for (const cloud of clouds) {
    const { ready, observation } = cloud
    const count = running.get(cloudCiId(cloud.provider)) ?? 0
    // A service Main is not logged in to and that runs nothing is not part of this installation.
    if ((!cloud.provider.recoveryOnly && (ready || cloud.provider.account?.registered === true
      || observation?.status === 'unavailable')) || count > 0) listed.push({
      provider: cloud.provider.id, ...(cloud.provider.account ? { account: cloud.provider.account.owner } : {}),
      ...(cloud.provider.circleAccountId && cloud.provider.circleAccountId !== 'default'
        ? { circleAccountId: cloud.provider.circleAccountId } : {}),
      name: cloud.provider.label, ready,
      slots: cloud.provider.recoveryOnly ? 0 : cloud.provider.slots, running: count, ...(observation ? { observation } : {}),
      ...(cloud.scheduling ?? (cloud.provider.id === 'circleci' && credits
        ? await credits.reading(cloud.provider.account?.owner, cloud.provider.circleAccountId) : {})) })
  }
  return listed
}

function readJobs(sql: pg.PoolClient, mainId: string) {
  return sql.query<{ target: unknown; activity: unknown }>(`select
    jsonb_build_object('hostRef', e.accepted_spec#>'{target,hostRef}',
      'applicationInstallationId', coalesce(e.accepted_spec#>'{target,registration,workerInstallationId}',
        e.accepted_spec#>'{target,mainInstallationId}'),
      'keyRevision', e.accepted_spec#>'{target,registration,keyRevision}',
      'authorizationRevision', e.accepted_spec#>'{target,registration,authorizationRevision}') as target,
    jsonb_build_object('id', e.id, 'name', v.record->>'name', 'workspaceId', e.workspace_id,
      'workspaceName', w.record->>'name', 'phase', e.record#>>'{process,phase}',
      'startedAt', e.record->'startedAt') as activity
    from job_executions e join job_definition_versions v on v.id=e.definition_version_id
    join workspaces w on w.id=e.workspace_id
    where e.accepted_spec#>>'{target,hostRef,mainId}'=$2
      and e.record#>>'{process,phase}' in ('preparing','running')
    order by e.created_at,e.id limit $1`, [COMPUTER_ACTIVITY_LIMIT + 1, mainId])
}

function readAgents(sql: pg.PoolClient, mainId: string) {
  return sql.query<{ target: unknown; activity: unknown }>(`select
    jsonb_build_object('hostRef', p.record->'hostRef',
      'applicationInstallationId', coalesce(p.record#>'{registration,workerInstallationId}',
        p.record->'mainInstallationId'), 'keyRevision', p.record#>'{registration,keyRevision}',
      'authorizationRevision', p.record#>'{registration,authorizationRevision}') as target,
    jsonb_build_object('id', e.id, 'workspaceId', r.workspace_id, 'workflowId', r.workflow_id,
      'workflowName', v.record#>>'{definition,name}', 'runId', r.id, 'nodeId', e.workflow_node_id,
      'agentName', a.record->>'name', 'state', e.record->>'state') as activity
    from harness_executions e join runs r on r.id=e.run_id
    join run_node_placements p on p.run_id=e.run_id and p.node_id=e.workflow_node_id
    join workflow_versions v on v.id=r.workflow_version_id join agents a on a.id=e.agent_id
    where p.record#>>'{hostRef,mainId}'=$2 and e.record->>'state' in ('starting','running','waiting')
    order by e.created_at,e.id limit $1`, [COMPUTER_ACTIVITY_LIMIT + 1, mainId])
}

async function readCiJobs(sql: pg.PoolClient, mainId: string, computers: ComputerActivity[]) {
  const rows = await sql.query<{ record: unknown; workspace_name: string }>(`select c.record,
    w.record->>'name' as workspace_name from ci_runs c join workspaces w on w.id=c.workspace_id
    where c.state in ('starting','running') and c.record#>>'{computer,hostRef,mainId}'=$2
      and c.record#>>'{computer,hostRef,kind}' in ('main','device')
    order by c.created_at,c.id limit $1`, [COMPUTER_ACTIVITY_LIMIT + 1, mainId])
  return rows.rows.flatMap(row => {
    const run = CiRunRecordSchema.parse(row.record)
    const hostRef = run.computer?.hostRef
    if (!hostRef) return []
    const computer = computers.find(value => value.target.hostRef.kind === hostRef.kind
      && value.target.hostRef.mainId === hostRef.mainId
      && (value.target.hostRef.kind === 'main'
        || hostRef.kind === 'device' && value.target.hostRef.deviceId === hostRef.deviceId))
    if (!computer) return []
    return [{ target: computer.target, activity: {
      id: run.id, name: `CI ${run.suite}`, workspaceId: run.workspaceId, workspaceName: row.workspace_name,
      phase: run.state === 'starting' ? 'preparing' : 'running', startedAt: run.startedAt,
    } }]
  })
}
