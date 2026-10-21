import { describe, expect, it } from 'vitest'
import { modelRequestDirectories } from './helpers/modelRequestDirectories.js'

const workerDirectory = '/fixture/worker-state'
const activeDirectory = `${workerDirectory}/native-codex-qualification-active`
const unusedDirectory = `${workerDirectory}/native-codex-qualification-unused`
const mainDirectory = '/fixture/main-runtime'
const providerVersion = '0.156.1'
const modelCall = (workingDirectory: string, version = providerVersion) => ({
  method: 'model/list', workingDirectory, providerVersion: version,
})

describe('Worker model request directories', () => {
  it('keeps waiting when Main and only one Worker profile have requested models', () => {
    const calls = [modelCall(mainDirectory), modelCall(activeDirectory)]

    expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([activeDirectory])

    calls.push(modelCall(unusedDirectory))
    expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([activeDirectory, unusedDirectory])
  })

  it.each(['before', 'between', 'after'] as const)(
    'selects both Worker checks with a Main request %s them', position => {
      const calls = [modelCall(activeDirectory), modelCall(unusedDirectory)]
      const index = { before: 0, between: 1, after: 2 }[position]
      calls.splice(index, 0, modelCall(mainDirectory))

      expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([activeDirectory, unusedDirectory])
    },
  )

  it.each(['before', 'between', 'after'] as const)(
    'selects both profile checks with a Worker catalog request %s them', position => {
      const calls = [modelCall(activeDirectory), modelCall(unusedDirectory)]
      const index = { before: 0, between: 1, after: 2 }[position]
      calls.splice(index, 0, modelCall(workerDirectory))

      expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([activeDirectory, unusedDirectory])
    },
  )

  it('keeps waiting when only Worker catalog and workflow requests have arrived', () => {
    const calls = [modelCall(workerDirectory), modelCall(`${workerDirectory}/worktrees/agent`)]

    expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([])
  })

  it.each(['before', 'between', 'after'] as const)(
    'ignores an obsolete Worker check arriving %s updated checks', position => {
      const obsoleteDirectory = `${workerDirectory}/native-codex-qualification-obsolete`
      const calls = [modelCall(activeDirectory), modelCall(unusedDirectory)]
      const index = { before: 0, between: 1, after: 2 }[position]
      calls.splice(index, 0, modelCall(obsoleteDirectory, '0.154.0'))

      expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([activeDirectory, unusedDirectory])
    },
  )

  it('keeps waiting when an obsolete check and only one updated check have requested models', () => {
    const calls = [modelCall(unusedDirectory, '0.154.0'), modelCall(activeDirectory)]

    expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([activeDirectory])
  })

  it('deduplicates model requests and excludes sibling directories and other methods', () => {
    const calls = [
      modelCall(activeDirectory),
      modelCall(activeDirectory),
      modelCall(`${workerDirectory}-other/native-codex-qualification-unused`),
      { method: 'thread/start', workingDirectory: unusedDirectory },
      modelCall(workerDirectory),
    ]

    expect(modelRequestDirectories(calls, workerDirectory, providerVersion)).toEqual([activeDirectory])
  })
})
