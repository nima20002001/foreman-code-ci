import {
  RemoteExecutionSettingsUpdateInputSchema,
  type ManagementPrincipal, type RemoteExecutionSettings, type RemoteExecutionSettingsUpdateInput,
  type RemoteExecutionRuntimeStatus,
} from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ProductionDeviceRuntime } from '../devices/productionRuntime.js'
import { readDeviceTlsMaterials, readOwnedDeviceTlsFile } from '../devices/tlsMaterials.js'
import type { PostgresFoundationSettingsRepository } from './foundation.js'
import type { WorkerExecutionPolicy } from './workerExecution.js'
import { remoteExecutionListenerConfig, resolveRemoteExecutionSettings } from './remoteExecutionConfig.js'

export class RemoteExecutionSettingsService {
  private applying: Promise<unknown> = Promise.resolve()
  private pendingReason: RemoteExecutionRuntimeStatus['reason'] = null

  constructor(
    private readonly settings: PostgresFoundationSettingsRepository,
    private readonly commands: PostgresCommandCoordinator,
    private readonly workerExecution: WorkerExecutionPolicy,
    private readonly runtime: Pick<ProductionDeviceRuntime, 'configureListener' | 'listenerStatus'>,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly apiPort: number,
    private readonly reportError: (error: unknown) => void,
  ) {}

  async read(principal: ManagementPrincipal) {
    requireAuthorization(principal, 'settings:read')
    const snapshot = await this.settings.getRemoteExecutionSettings()
    return { ...snapshot, ...resolveRemoteExecutionSettings(snapshot.value, this.environment), runtime: this.status() }
  }

  async initialize(): Promise<void> {
    await this.applySavedSettings({ startup: true })
  }

  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: RemoteExecutionSettingsUpdateInput) {
    requireAuthorization(principal, 'settings:update')
    const input = RemoteExecutionSettingsUpdateInputSchema.parse(raw)
    const result = await this.commands.execute({
      principal, source, operation: 'remote.execution.settings.update', commandId: input.commandId,
      targetKey: 'remote-execution-settings', payload: input,
      authorize: async client => {
        requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:update')
      },
      perform: async client => {
        await this.validate(input.value)
        await this.validate(resolveRemoteExecutionSettings(input.value, this.environment).effective)
        return this.settings.updateRemoteExecutionSettings(input.value, input.expectedRevision, client)
      },
    })
    // Read the latest committed record so concurrent saves and retries cannot apply an older receipt.
    await this.applySavedSettings({ startup: false })
    return { ...result, runtime: this.status() }
  }

  private status(): RemoteExecutionRuntimeStatus {
    return { ...this.runtime.listenerStatus(), restartRequired: this.pendingReason !== null, reason: this.pendingReason }
  }

  private async validate(value: RemoteExecutionSettings): Promise<void> {
    try {
      const config = remoteExecutionListenerConfig(value, this.apiPort)
      if (config) {
        await readDeviceTlsMaterials(config)
        return
      }
      for (const path of [value.listener.certificateFile, value.listener.privateKeyFile]) {
        if (path) await readOwnedDeviceTlsFile(path)
      }
    } catch {
      throw new DomainError('REMOTE_EXECUTION_SETTINGS_INVALID',
        'Use a separate listener port and valid TLS files owned by Main’s OS user with owner-only permissions.', 400)
    }
  }

  private applySavedSettings(options: { startup: boolean }): Promise<void> {
    const apply = async () => {
      const saved = await this.settings.getRemoteExecutionSettings()
      const { effective, environmentOverrides } = resolveRemoteExecutionSettings(saved.value, this.environment)
      this.workerExecution.apply({
        enabled: effective.enabled,
        managedBy: environmentOverrides.includes('FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED') ? 'startup' : 'settings',
      })
      try {
        const applied = await this.runtime.configureListener(remoteExecutionListenerConfig(effective, this.apiPort))
        this.pendingReason = applied ? null : 'computers-connected'
      } catch (error) {
        this.pendingReason = 'listener-start-failed'
        if (options.startup) throw error
        this.reportError(error)
      }
    }
    const task = this.applying.then(apply, apply)
    this.applying = task
    return task
  }
}
