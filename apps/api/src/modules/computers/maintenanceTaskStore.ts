import { MaintenanceTaskSchema, type MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import type { MaintenancePorts } from './maintenancePorts.js'

/** Acknowledged tasks remain readable even when the process that ran them stops. */
export class MaintenanceTaskStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly path: string,
    private readonly ports: Pick<MaintenancePorts, 'readText' | 'writePrivateText' | 'now'>) {}

  async load(): Promise<MaintenanceTask[]> {
    const text = await this.ports.readText(this.path)
    if (!text) return []
    const tasks = MaintenanceTaskSchema.array().max(20).parse(JSON.parse(text))
    let interrupted = false
    for (const task of tasks) {
      if (task.state !== 'running' || task.kind === 'update-worker' && task.workerTargetVersion !== undefined) continue
      task.state = 'failed'
      task.summary = 'Maintenance was interrupted when the application stopped. Check its status before retrying.'
      task.finishedAt = this.ports.now().toISOString()
      interrupted = true
    }
    if (interrupted) await this.save(tasks)
    return tasks
  }

  save(tasks: readonly MaintenanceTask[]): Promise<void> {
    const text = `${JSON.stringify(tasks)}\n`
    this.writes = this.writes.then(() => this.ports.writePrivateText(this.path, text))
    return this.writes
  }

  flushed(): Promise<void> { return this.writes }
}
