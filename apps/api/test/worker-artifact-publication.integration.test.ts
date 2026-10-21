import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { NativeArtifactOutputSchema } from '../src/modules/runs/remote/nativeArtifactOutputs.js'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'
import { completedRun, startWhenReady } from './helpers/harnessInstallationUpdate.js'

it('publishes a declared Worker artifact and reads its persisted size and hash', async () => {
  const f = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker',
    parallelSetup: true, parallelProfileChecks: true, includeNodeRuntimePayload: false,
    sourceAccessMode: 'exclusive-write', artifactOutputKeys: ['report'], profilePostgres: true })
  const content = 'Original report bytes\n'
  let runId: string | undefined
  try {
    await writeFile(join(f.provider.directory, 'workflow-artifact.json'), JSON.stringify({ outputKey: 'report', content }))
    const started = (await startWhenReady(f))!
    runId = started.run.id
    const finished = await completedRun(f, started.run.id)
    console.log('PG-PROFILE', JSON.stringify(f.databaseProfile()))
    expect(finished.executions).toHaveLength(1)
    const execution = finished.executions[0]!
    expect(execution).toMatchObject({ state: 'completed', attempt: 1, result: { outcome: 'succeeded' } })
    const outputs = await f.db.pool.query<{ result: unknown }>(`select result from management_command_receipts
      where operation='remote.native-artifact.output' and result#>>'{producer,executionId}'=$1`, [execution.id])
    expect(outputs.rows).toHaveLength(1)
    const output = NativeArtifactOutputSchema.parse(outputs.rows[0]!.result)
    expect(output).toMatchObject({ outputKey: 'report',
      pins: { byteSize: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') } })
    const body = execution.result!.output as { text: string }
    expect(JSON.parse(body.text)).toMatchObject({ artifactOutputs: {
      version: 1, outputs: [{ outputKey: 'report', commandId: output.commandId }],
    } })
    const receipts = await f.db.pool.query<{ receipt: unknown }>(`select receipt from remote_execution_receipts
      where receipt#>>'{intent,executionId}'=$1`, [execution.id])
    expect(receipts.rows).toHaveLength(1)
    expect(RemoteOperationReceiptSchema.parse(receipts.rows[0]!.receipt)).toMatchObject({
      outputValidationComplete: true, terminal: { kind: 'completed' }, native: { sessionId: execution.nativeSessionId },
    })
    const calls = await f.provider.calls()
    expect(calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `execution:${execution.id}`)).toHaveLength(1)
    expect(calls.some(call => call.method === 'turn/interrupt' && call.threadId === execution.nativeSessionId)).toBe(false)
  } catch (error) {
    console.error('PG-PROFILE', JSON.stringify(f.databaseProfile()))
    console.error('Worker artifact failure', error, JSON.stringify(f.failures()))
    const commands = (await f.provider.calls()).filter(call => call.providerFailure || call.nativeShell || call.nativeOutput)
    if (runId) {
      const details = await f.details(runId)
      console.error('Artifact progress', JSON.stringify({ commands,
        runState: details.run.executionState, receipts: await f.workerWorkflowStartup(),
        executions: details.executions.map(({ id, state, result, nativeSessionId }) => ({ id, state, result, nativeSessionId })) }))
    }
    throw error
  } finally { await f.close() }
}, 240000)
