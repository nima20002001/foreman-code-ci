import { vi } from 'vitest'
import type { HarnessExecution, HarnessExecutionRequest } from '@foreman-code/contracts'
import { WorkActivationInputSchema, makeCurrentWorkflowFixture, type WorkHandoffResult } from '@foreman-code/contracts/wave25'
import { RepeatRunRepository } from '../../src/modules/runs/repeatPostgres.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'
import { br1002At } from './wave25Br1002Cuts.js'
import { rejectableDeferred } from './deferred.js'

export async function workHandoffRuntimeFixture(definition: ReturnType<typeof makeCurrentWorkflowFixture>,
  result: (nodeId: string, request: HarnessExecutionRequest) => WorkHandoffResult) {
  return checkpointRuntimeFixture(1, 1, { fixture: definition, approvalNodeIds: [],
    outputFor: (nodeId, request) => ({ text: JSON.stringify(result(nodeId, request)) }),
  })
}

type Fixture = Awaited<ReturnType<typeof workHandoffRuntimeFixture>>

/** Pause after terminal acceptance and before routing, then recompose the engine. */
export async function runWorkHandoffWithRestart(f: Fixture, restart: boolean,
  atAcceptance: (execution: HarnessExecution) => boolean) {
  if (!restart) {
    await f.engine.start(f.f.run.id)
    return f
  }
  const accepted = rejectableDeferred<void>()
  const release = rejectableDeferred<void>()
  const closing = rejectableDeferred<void>()
  let paused = false
  const accept = RepeatRunRepository.prototype.acceptWorkTerminal
  const pause = vi.spyOn(RepeatRunRepository.prototype, 'acceptWorkTerminal').mockImplementation(async function (
    this: RepeatRunRepository, ...args: Parameters<RepeatRunRepository['acceptWorkTerminal']>
  ) {
    const terminal = await accept.apply(this, args)
    if (!paused && terminal.kind === 'accepted' && atAcceptance(terminal.execution)) {
      paused = true
      WorkActivationInputSchema.parse(terminal.execution.input)
      accepted.resolve()
      await release.promise
    }
    return terminal
  })
  const closeForRestart = f.native.closeForRestart.bind(f.native)
  const close = vi.spyOn(f.native, 'closeForRestart').mockImplementation(() => {
    const task = closeForRestart()
    closing.resolve()
    return task
  })
  const start = f.engine.start(f.f.run.id)
  const settled = Promise.allSettled([start])
  try {
    await br1002At(accepted.promise, start)
    const shutdown = f.engine.shutdown()
    await br1002At(closing.promise, shutdown)
    release.resolve()
    await shutdown
    await settled
    pause.mockRestore()
    close.mockRestore()
    const runtime = f.compose()
    await runtime.engine.start(f.f.run.id)
    return runtime
  } finally {
    release.resolve()
    pause.mockRestore()
    close.mockRestore()
    await settled
  }
}
