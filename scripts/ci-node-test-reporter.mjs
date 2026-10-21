// Emits the same report shape as Vitest so CI can merge results from both runners.
import { relative } from 'node:path'
import { writeCiProgressEvent } from './ci-progress-reporter.mjs'

export default async function* reportTests(events) {
  const files = new Map()
  for await (const { type, data } of events) {
    const module = data.name === data.file || data.type === 'suite' || data.details?.type === 'suite'
    if (data.file && type === 'test:dequeue') {
      writeCiProgressEvent('start', { kind: module ? 'module' : 'test',
        id: `${data.nesting}:${data.name}`, file: relative(process.env.CI_REPOSITORY_ROOT ?? process.cwd(), data.file),
        name: module ? '' : data.name })
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue
    if (data.file && (module || data.skip === undefined && data.todo === undefined)) {
      writeCiProgressEvent('finish', { kind: module ? 'module' : 'test', id: `${data.nesting}:${data.name}`,
        file: relative(process.env.CI_REPOSITORY_ROOT ?? process.cwd(), data.file), name: module ? '' : data.name })
    }
    if (data.details?.type === 'suite' || data.details?.error?.failureType === 'subtestsFailed') continue
    const name = data.file ?? 'unknown file'
    const file = files.get(name) ?? { name, status: 'passed', assertionResults: [] }
    const skipped = data.skip !== undefined || data.todo !== undefined
    const status = skipped ? 'pending' : type === 'test:fail' ? 'failed' : 'passed'
    if (status === 'failed') file.status = 'failed'
    const error = data.details?.error
    const failure = error?.cause?.stack ?? error?.stack ?? error?.message
    file.assertionResults.push({ fullName: data.name, status, duration: data.details?.duration_ms ?? null,
      ...(failure ? { failureMessages: [failure] } : {}) })
    files.set(name, file)
  }
  yield JSON.stringify({ testResults: [...files.values()] })
}
