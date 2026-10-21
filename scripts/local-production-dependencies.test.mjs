import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { deployProductionApi } from './local-production-runtime.mjs'

const execute = promisify(execFile)

for (const stalledCommand of ['deploy', 'install']) {
  test(`a stalled dependency ${stalledCommand} is killed and reported`, async () => {
    const calls = []
    const run = async (_command, args, options) => {
      calls.push(args)
      if (!args.includes(stalledCommand)) throw new Error('Deployment failed before restoration')
      assert.ok(Number.isFinite(options?.timeout) && options.timeout > 0, 'Dependency commands need a deadline')
      assert.equal(options.killSignal, 'SIGKILL', 'A stalled package manager must not ignore termination')
      // Exercise the subprocess contract with a short deadline instead of waiting for the production limit.
      return execute(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { ...options, timeout: 100 })
    }
    await assert.rejects(deployProductionApi(run, 'unused-destination'), error => {
      const failures = error instanceof AggregateError ? error.errors : [error]
      const timeout = failures.find(failure => failure.cause?.signal === 'SIGKILL')
      assert.ok(timeout, failures.map(failure => failure.message).join('\n'))
      assert.match(error.message, /Production dependency command.*timeout/i)
      assert.match(timeout.message, /Production dependency command.*timeout/i)
      assert.ok(timeout.message.includes(stalledCommand))
      return true
    })
    assert.equal(calls.length, 2, 'Workspace restoration must still be attempted')
  })
}
