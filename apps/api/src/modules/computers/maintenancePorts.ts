import type { MaintainedHarness, MaintenanceTask, WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'

export interface MaintenancePluginBackup {
  restore(): Promise<void>
  discard(): Promise<void>
}

export interface MaintenancePorts {
  environment: NodeJS.ProcessEnv
  /** Absolute executable path, or null when not installed. */
  find(name: string): Promise<string | null>
  run(binary: string, args: string[], options: {
    signal: AbortSignal; timeoutMs: number; environment?: NodeJS.ProcessEnv | undefined
  }): Promise<{ code: number | null; stdout: string; stderr: string }>
  exists(path: string): Promise<boolean>
  readText(path: string): Promise<string | null>
  /** Writes a private (0600) file atomically, creating its directory. */
  writePrivateText(path: string, text: string): Promise<void>
  backupPlugin?(harness: MaintainedHarness, pluginId: string): Promise<MaintenancePluginBackup>
  /** Replace a native Git marketplace snapshot without updating installed plugin caches. */
  refreshCodexMarketplace?(binary: string, name: string, acquiredRoot: string, signal: AbortSignal): Promise<void>
  disk(path: string): Promise<{ freeBytes: number; totalBytes: number } | null>
  /** Runs fn after ms; restart uses it so the reply reaches Main before the computer goes down. */
  later(fn: () => void, ms: number): void
  now(): Date
  /** Moves this computer's runtime selection to the installed update. Qualification still checks the selected binary. */
  selectInstalledCodex?(signal: AbortSignal): Promise<string | null>
  selectInstalledClaude?(signal: AbortSignal): Promise<string | null>
  workerUpdate?: {
    status(): Promise<WorkerUpdateStatus>
    start(options: { retry: boolean }): Promise<string>
    /** Returns a retained outcome only when it completed by the task's deadline. */
    outcome?(task: MaintenanceTask, deadlineAt: string): Promise<WorkerUpdateStatus | null>
  }
}
