import { relative } from 'node:path'
import { TestRunner } from 'vitest'
import { writeCiProgressEvent } from '../../scripts/ci-progress-reporter.mjs'

export default class CiTestRunner extends TestRunner {
  record(type, task) {
    const names = [task.name]
    for (let suite = task.suite; suite; suite = suite.suite) names.unshift(suite.name)
    writeCiProgressEvent(type, {
      id: task.id, kind: 'test', name: names.join(' > '),
      file: relative(process.env.CI_REPOSITORY_ROOT ?? this.config.root, task.file.filepath).replaceAll('\\', '/'),
    })
  }

  async onBeforeRunTask(task) {
    await super.onBeforeRunTask(task)
    // Vitest batches IPC updates; a synchronous loop prevents the reporter from receiving its ready event.
    if (task.mode === 'run' || task.mode === 'queued') this.record('start', task)
  }

  onAfterRunTask(task) {
    super.onAfterRunTask(task)
    this.record('finish', task)
  }
}
