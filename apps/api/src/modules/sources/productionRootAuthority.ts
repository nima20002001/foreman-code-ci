import type pg from 'pg'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { MaterializationAttempt } from './ports.js'
import type { RegisteredSourceRootPort } from './admissionPorts.js'
import type { SourceAttemptAuthority } from './executionHosts.js'
import type { WorkspaceRootHostPort } from './rootPolicyPorts.js'
import { PostgresWorkspaceRootPolicies, workspaceRootHostScope } from './rootPolicies.js'
import { InstalledWorkspaceRootHosts } from './rootHosts.js'
import { RegisteredWorkspaceSourceRoots } from './registeredSourceRoots.js'
import { readInstalledRootConfiguration } from './installedRootConfiguration.js'

export function createProductionRootPolicies(input: {
  pool: pg.Pool; mainId: string; runtimeRoot: string; endpoint(): DeviceEndpoint
}) {
  const unavailable = (): never => {
    throw new DomainError('SOURCE_REMOTE_UNAVAILABLE', 'The authenticated source materialization host is not installed.', 409)
  }
  const hosts: WorkspaceRootHostPort = {
    async configuration(sql, host) {
      if (host.kind === 'main') return readInstalledRootConfiguration(join(input.runtimeRoot, 'approved-roots.json'))
      const row = (await sql.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2 for share', [host.deviceId, host.mainId])).rows[0]
      if (!row) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected root host is not registered.', 403)
      const registration = DeviceRegistrationSchema.parse(row.record)
      await assertDeviceHostInstallation(sql, host, registration.workerInstallationId)
      const endpoint = input.endpoint()
      const captured = endpoint.captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)
      if (!captured || captured.binding.mainId !== host.mainId || captured.binding.workerInstallationId !== registration.workerInstallationId
        || captured.binding.keyRevision !== registration.keyRevision || captured.binding.authorizationRevision !== registration.authorizationRevision) unavailable()
      const signal = AbortSignal.timeout(10_000)
      const reply = await captured!.request({ version: 1, operation: 'workspace-roots.configuration' }, { signal })
        .catch((error: unknown) => {
          if (!(error instanceof DeviceApplicationError) || error.code !== 'cancelled'
            || !signal.aborted || !(signal.reason instanceof Error) || signal.reason.name !== 'TimeoutError') throw error
          // The channel reports aborts as cancellation; only this request's own deadline means unavailability.
          throw new DomainError('timeout', 'The selected computer did not respond. Reconnect it and retry.',
            503, undefined, { cause: signal.reason })
        })
      if (reply.bytes !== undefined || !isDeepStrictEqual(endpoint.currentBinding(host.deviceId), captured!.binding))
        throw new DomainError('ROOT_DEVICE_CONFLICT', 'The authenticated root configuration channel changed during adoption.', 409)
      const configuration = ApprovedRootAllowlistSchema.parse(reply.payload)
      if (!isDeepStrictEqual(configuration.hostRef, host) || configuration.applicationInstallationId !== registration.workerInstallationId)
        throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'The approved configuration belongs to another host installation.', 409)
      return configuration
    },
    authorize: async (sql, _principal, host, installationId) => {
      const registration = await assertDeviceHostInstallation(sql, host, installationId)
      return registration ? { workerInstallationId: registration.workerInstallationId,
        keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision } : null
    },
    async configurations(sql) {
      const rows = await sql.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
        join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
        where c.main_id=$1 order by h.host_scope`, [input.mainId])
      return rows.rows.map(row => ApprovedRootAllowlistSchema.parse(row.record))
    },
    attest: async root => (await installed(root.selection.hostRef)).attest(root),
    prepareManaged: async root => (await installed(root.selection.hostRef)).prepareManaged(root),
    browse: async (root, path) => (await installed(root.selection.hostRef)).browse(root, path),
    sourceNamespace: async (policy, id) => (await installed(policy.hostRef)).sourceNamespace(policy, id),
  }
  async function installed(host: Parameters<typeof workspaceRootHostScope>[0]) {
    const rows = await input.pool.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
      join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
      where h.host_scope=$1`, [workspaceRootHostScope(host)])
    if (!rows.rows[0]) throw new DomainError('ROOT_CONFIGURATION_MISSING', 'The selected host has no explicit human-approved root configuration.', 409)
    const configuration = ApprovedRootAllowlistSchema.parse(rows.rows[0].record)
    return new InstalledWorkspaceRootHosts(configuration, hosts.authorize, { async request(host, registration, request) {
      if (host.kind !== 'device') throw new DomainError('ROOT_HOST_MISMATCH', 'The remote root request must target its actual registered device.', 409)
      const endpoint = input.endpoint()
      const binding = endpoint.currentBinding(host.deviceId)
      if (!binding || binding.mainId !== host.mainId || binding.workerInstallationId !== registration.workerInstallationId
        || binding.keyRevision !== registration.keyRevision || binding.authorizationRevision !== registration.authorizationRevision) unavailable()
      return (await endpoint.request(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace, request)).payload
    } })
  }
  const policies = new PostgresWorkspaceRootPolicies(input.mainId, hosts)
  const roots: RegisteredSourceRootPort = new RegisteredWorkspaceSourceRoots(policies, hosts)
  return { policies, roots }
}

export function rootPolicySourceAttempts(input: {
  pool: pg.Pool; roots: RegisteredSourceRootPort; originalAttempts: SourceAttemptAuthority
  prepareIdentity(root: SourceRootRecord, attempt: MaterializationAttempt): Promise<unknown>
}): SourceAttemptAuthority {
  const { roots, originalAttempts } = input
  const assertRootPolicy = async (sql: GraphSqlClient, principal: ManagementPrincipal, root: SourceRootRecord) => {
    const current = await roots.authorize(sql, principal, {
      workspaceId: root.binding.workspaceId, selection: root.selection, accessMode: root.binding.accessMode,
    })
    if (current.mainId !== root.binding.mainId || current.deviceId !== root.binding.deviceId
      || current.workerInstallationId !== root.binding.workerInstallationId || current.keyRevision !== (root.registration?.keyRevision ?? null)
      || current.authorizationRevision !== (root.registration?.authorizationRevision ?? null)
      || current.canonicalPath !== root.binding.canonicalPath) {
      throw new DomainError('SOURCE_ROOT_CONFLICT',
        'Current root authority differs from the exact accepted source namespace.', 409)
    }
  }
  const readRoot = async (sql: GraphSqlClient, record: Parameters<SourceAttemptAuthority['revalidateMaterialization']>[0]) => {
    const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',
      [record.receipt.binding.rootId, record.receipt.binding.bindingRevision])).rows[0]
    return SourceRootRecordSchema.parse(row?.record)
  }
  const attempts: SourceAttemptAuthority = {
    async authorize(sql, principal, value, lock) {
      await originalAttempts.authorize(sql, principal, value, lock)
      await assertRootPolicy(sql, principal, value.root)
    },
    async authorizeFinal(sql, principal, record, hash, lock) {
      await originalAttempts.authorizeFinal(sql, principal, record, hash, lock)
      await assertRootPolicy(sql, principal, await readRoot(sql, record))
    },
    async revalidate(root, attempt) {
      await input.prepareIdentity(root, attempt)
    },
    async revalidateMaterialization(record) {
      const sql = await input.pool.connect()
      let root: SourceRootRecord
      try {
        root = await readRoot(sql, record)
      } finally {
        sql.release()
      }
      await originalAttempts.revalidateMaterialization(record)
      await input.prepareIdentity(root, record.receipt)
    },
  }
  return attempts
}
