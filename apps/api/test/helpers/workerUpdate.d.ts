// The Worker runtime is JavaScript; API tests use this public updater surface.
declare module '*worker/src/update.mjs' {
  type WorkerUpdateStatus = import('@foreman-code/contracts/computer-maintenance').WorkerUpdateStatus
  type WorkerArtifactManifest = import('@foreman-code/contracts/computer-maintenance').WorkerArtifactManifest

  export class WorkerUpdater {
    constructor(options: Record<string, unknown>)
    initialize(): Promise<this>
    status(): Promise<WorkerUpdateStatus>
    start(options?: { retry?: boolean }): Promise<string>
    close(): Promise<void> | undefined
  }

  export function downloadWorkerArtifact(options: Record<string, unknown>): Promise<WorkerArtifactManifest>
}
