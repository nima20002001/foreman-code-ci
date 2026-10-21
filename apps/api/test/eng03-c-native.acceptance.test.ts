import { waitForStartedBranches } from './helpers/nativeAcceptanceState.js'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { readCurrentExecutions } from './helpers/wave25Agent3.js'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import { HarnessExecutionSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { cgroupBoundary, killCgroup } from '../src/modules/harnesses/recovery/cgroupBoundary.js'
import { bootIdentity, identityAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import type { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { repeatDigest, type RepeatNodeInput, type RepeatInputBinding } from '../src/modules/runs/repeatResolution.js'
import { RepeatRunRepository } from '../src/modules/runs/repeatPostgres.js'
import { nativeAcceptanceBinaries, runEng03NativeScenario, type Eng03NativeControl } from './helpers/eng03NativeAcceptance.js'
import { configureNativeWorkflowMcp } from './helpers/nativeWorkflowMcp.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { codexMcpInspectorAdapter } from '../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { provisionTestResources } from '../../../scripts/test-resources.mjs'
import { stopGroup } from '../../../scripts/integration-process.mjs'

function waitForOwnerBeforeWork(release: string, work: string): string {
  return `Before the following work, use the native shell tool once to run exactly: while [ ! -f '${release}' ]; do sleep 0.1; done. `
    + `This reads an owner-controlled fixture; do not create or modify it, and do not finish before the command returns. `
    + `If the tool returns a running command session, poll that same native session until it finishes; do not start another command. Then ${work}`
}

describe('acceptance Job binary configuration', () => {
  it('denies missing in-image binaries instead of selecting owner installations', () => {
    expect(() => nativeAcceptanceBinaries({ FOREMAN_CODE_VERIFICATION_ROOT: '/source' }))
      .toThrow('explicitly qualified in-image')
  })

  it('retains the explicitly qualified Codex binary path', () => {
    expect(nativeAcceptanceBinaries({ FOREMAN_CODE_VERIFICATION_ROOT: '/source',
      ENG03_A_CODEX_BINARY: '/opt/codex' }))
      .toEqual({ codexBinary: '/opt/codex' })
  })
})

const require = createRequire(import.meta.url)

async function startedBranches(context: Eng03NativeControl) {
  const started = await waitForStartedBranches(context)
  expect(started).toHaveLength(2)
  expect(new Set(started.map((item) => item.native_session_id)).size).toBe(2)
  return started
}

/** Paid-provider, task-owned internal qualification. Public app acceptance is separate. */
describe.skipIf(process.env.RUN_ENG03_C_NATIVE_TESTS !== '1')('ENG-03 C live native lifecycle', () => {
  it('uses the fixture MCP launcher and rejects an unmanaged replacement before credential delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-workflow-mcp-'))
    const codexBinary = process.env.ENG03_A_CODEX_BINARY ?? harnessBinaries(process.env).codexBinary
    const manager = new CodexAppServerSessionManager(codexBinary)
    let restore: (() => Promise<void>) | undefined
    try {
      restore = await configureNativeWorkflowMcp({ projectDirectory: directory,
        runtimeDirectory: directory, codexBinary })
      const configured = await manager.inspectMcpConfiguration(directory)
      expect(configured.configured.automaticEndpoint).toBe(true)
      const detection = new McpDetectionService(codexMcpInspectorAdapter(manager), 'http://127.0.0.1:1/mcp')
      const input = { harness: 'codex' as const, runnerId: 'fixture', workingDirectory: directory }
      expect((await detection.preflight(input)).detection.state).toBe('status_unavailable')
      await writeFile(join(process.env.CODEX_HOME!, 'config.toml'), [
        `[mcp_servers.${configured.serverName}]`,
        `command = ${JSON.stringify(process.execPath)}`,
        'args = ["--version"]',
        `env_vars = [${JSON.stringify(configured.configured.bearerTokenEnvironmentVariable)}]`,
        '',
      ].join('\n'), { mode: 0o600 })
      await expect(detection.preflight(input)).rejects.toMatchObject({ code: 'APP_MCP_PREFLIGHT_FAILED' })
    } finally {
      try { await manager.dispose() }
      finally {
        try { await restore?.() }
        finally {
          await removeFixtureDirectory(directory)
        }
      }
    }
  }, 90_000)
  it.each(['unset', 'enabled'])(
    'retains the acceptance helper database and runtime after uncertain closure with keep-runtime %s', async keep => {
      const input = { ...process.env }
      delete input.FOREMAN_CODE_TEST_ROOT
      delete input.FOREMAN_CODE_TEST_OWNER
      const resources = await provisionTestResources(input)
      const environment = { ...resources.environment }
      if (keep === 'enabled') environment.ENG03_A_KEEP_RUNTIME = '1'
      else delete environment.ENG03_A_KEEP_RUNTIME
      const observation = join(environment.FOREMAN_CODE_TEST_ROOT!, 'acceptance-retention.json')
      const probe = fileURLToPath(new URL('./helpers/nativeAcceptanceRetentionProbe.ts', import.meta.url))
      const child = spawn(process.execPath, ['--import', require.resolve('tsx'), probe, observation], {
        env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout?.resume()
      child.stderr?.resume()
      const errors: unknown[] = []
      try {
        const [code] = await once(child, 'exit', { signal: AbortSignal.timeout(200_000) })
        expect(code).toBe(0)
        const reported = JSON.parse(await readFile(observation, 'utf8')) as {
          runId: string; artifactPath: string; branchCount: number
        }
        expect(reported.branchCount).toBe(2)
        const artifact = JSON.parse(await readFile(reported.artifactPath, 'utf8')) as {
          resources: { invocation: { directory: string; token: string }; cleanupId: string;
            root: string; schema: string; registryDirectory: string }
          resourcesRetained: boolean
        }
        expect(artifact.resourcesRetained).toBe(true)
        expect(existsSync(artifact.resources.registryDirectory)).toBe(true)
        await expect(resources.close()).rejects.toThrow('cleanup remains unconfirmed')
        const pool = new pg.Pool({ connectionString: resources.environment.TEST_DATABASE_URL,
          options: `-c search_path=${artifact.resources.schema}`, max: 1 })
        try {
          expect((await pool.query('select id from runs where id=$1', [reported.runId])).rows)
            .toEqual([{ id: reported.runId }])
        } finally { await pool.end() }
        const registryModule = new URL('../src/modules/harnesses/recovery/processRegistry.ts', import.meta.url).href
        const resourcesModule = new URL('../../../scripts/test-resources.mjs', import.meta.url).href
        const recovery = spawn(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', `
          import pg from ${JSON.stringify(pathToFileURL(require.resolve('pg')).href)};
          import { NativeProcessRegistry } from ${JSON.stringify(registryModule)};
          import { completeTestResourceCleanup, dropFixtureSchema, ownedTestDatabaseUrl, removeFixtureDirectory }
            from ${JSON.stringify(resourcesModule)};
          const saved = ${JSON.stringify(artifact.resources)};
          const registry = new NativeProcessRegistry(saved.registryDirectory);
          for (const owner of new Set(registry.snapshot().launches.map(launch => launch.owner))) {
            if (!await registry.closeOwner(owner)) throw new Error('Native closure remains unconfirmed');
          }
          const pool = new pg.Pool({ connectionString: ownedTestDatabaseUrl(), max: 1 });
          try { await dropFixtureSchema(pool, saved.schema); } finally { await pool.end(); }
          await removeFixtureDirectory(saved.root);
          completeTestResourceCleanup(saved.invocation, saved.cleanupId);
        `], { env: resources.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        recovery.stdout?.resume()
        recovery.stderr?.resume()
        try {
          const [code] = await once(recovery, 'exit')
          expect(code).toBe(0)
        } finally { await stopGroup(recovery.pid) }
        expect(existsSync(artifact.resources.root)).toBe(false)
        await resources.close()
        expect(existsSync(resources.environment.FOREMAN_CODE_TEST_ROOT!)).toBe(false)
      } catch (error) { errors.push(error) }
      finally {
        try { await stopGroup(child.pid) }
        catch (error) { errors.push(error) }
        if (existsSync(resources.environment.FOREMAN_CODE_TEST_ROOT!)) {
          try { await resources.close() }
          catch (error) { errors.push(error) }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Acceptance retention probe failed')
    }, 240_000)

  it('E03-L01 stops two positively started Codex branches without starting Reviewer', async () => {
    let started: Array<{ execution_id: string; native_session_id: string }> = []
    const result = await runEng03NativeScenario('E03-L01', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, stop, runs, startTask } = context
        started = await startedBranches(context)
        await stop()
        await startTask.catch(() => undefined)
        expect((await runs.get(runId))?.outcome).toBe('canceled')
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(0)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; nativeEventSummary: Array<{ id: string; events: Array<{ type: string }> }>
    }
    expect(artifact.runOutcome).toBe('canceled')
    expect(artifact.cleanup).toBe(true)
    expect(started).toHaveLength(2)
  }, 180_000)

  it('E03-L02 fails the Run when one active task-owned process closes, then settles its sibling', async () => {
    let interruptedExecutionId = ''
    let originalBranches: Array<{ execution_id: string; native_session_id: string }> = []
    const result = await runEng03NativeScenario('E03-L02', 'codex', 'codex', {
      prompts: {
        A: waitForOwnerBeforeWork('release-native-fault', 'read the accepted Entry result. Without more tools or files, list n and n squared modulo 97 for n=1 through 120, one row per n. Finish with A-FAULT. Keep the response under 3000 characters.'),
        B: waitForOwnerBeforeWork('release-native-fault', 'read the accepted Entry result. Without more tools or files, list n and n cubed modulo 101 for n=1 through 120, one row per n. Finish with B-FAULT. Keep the response under 3000 characters.'),
      },
      control: async (context) => {
        const { pool, runId, nodeIds, projectDirectory, registry, runs, startTask } = context
        const started = await startedBranches(context)
        originalBranches = started
        interruptedExecutionId = started[0]!.execution_id
        try {
          await registry.closeOwner(`execution:${interruptedExecutionId}`)
          await startTask.catch(() => undefined)
          expect((await runs.get(runId))?.outcome).toBe('failed')
          expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
            [runId, nodeIds[3]])).rowCount).toBe(0)
        } finally { await writeFile(join(projectDirectory, 'release-native-fault'), 'release') }
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; activeCredentialCount: number
      executions: Array<{ id: string; nativeSessionId?: string; result?: { outcome: string; error?: { code: string; retryable: boolean } } }>
    }
    expect(artifact.runOutcome).toBe('failed')
    expect(artifact.cleanup).toBe(true)
    // The interrupted turn has a genuine native canceled source. Without a
    // persisted Stop, closure without an accepted terminal is EXECUTION_INTERRUPTED.
    expect(artifact.executions.find((item) => item.id === interruptedExecutionId)?.result?.outcome).toBe('canceled')
    const sibling = originalBranches.find((item) => item.execution_id !== interruptedExecutionId)!
    expect(artifact.executions.find((item) => item.id === sibling.execution_id)?.result).toMatchObject({
      outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false },
    })
    for (const original of originalBranches) expect(artifact.executions.find((item) => item.id === original.execution_id)?.nativeSessionId).toBe(original.native_session_id)
    expect(artifact.activeCredentialCount).toBe(0)
  }, 180_000)

  it('E03-L02 fails after an exact task-owned native cgroup exits abnormally', async () => {
    let interruptedExecutionId = ''
    let originalBranches: Array<{ execution_id: string; native_session_id: string }> = []
    let fault: { registrationId: string; guardianPid: number; guardianStartTicks: string; cgroup: string; at: string } | undefined
    const result = await runEng03NativeScenario('E03-L02', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, runtimeDirectory, registry, runs, startTask } = context
        const started = await startedBranches(context)
        originalBranches = started
        interruptedExecutionId = started[0]!.execution_id
        const owner = `execution:${interruptedExecutionId}`
        const scope = registry.scope(owner)
        expect(scope.root).toBe(join(runtimeDirectory, 'native-process-registry'))
        const ownerDirectory = join(scope.root, createHash('sha256').update(owner).digest('hex'))
        const registrations = (await readdir(ownerDirectory)).filter((item) => /^[0-9a-f-]{36}$/.test(item))
        expect(registrations).toHaveLength(1)
        const id = registrations[0]!
        const intent = JSON.parse(await readFile(join(ownerDirectory, id, 'intent.json'), 'utf8')) as {
          id: string; owner: string; boot: string
        }
        const birth = JSON.parse(await readFile(join(ownerDirectory, id, 'birth.json'), 'utf8')) as {
          id: string; owner: string; boot: string; guardian: { pid: number; startTicks: string }; containment: unknown
        }
        expect(intent).toMatchObject({ id, owner, boot: bootIdentity() })
        expect(birth).toMatchObject({ id, owner, boot: intent.boot })
        expect(identityAlive(birth.guardian)).toBe(true)
        const boundary = cgroupBoundary(birth.containment, id)
        fault = { registrationId: id, guardianPid: birth.guardian.pid,
          guardianStartTicks: birth.guardian.startTicks, cgroup: boundary.path, at: new Date().toISOString() }
        killCgroup(boundary)
        await startTask.catch(() => undefined)
        expect((await runs.get(runId))?.outcome).toBe('failed')
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(0)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runId: string; runOutcome: string; cleanup: boolean; activeCredentialCount: number
      executions: Array<{ id: string; nativeSessionId?: string; result?: { outcome: string; error?: { code: string; retryable: boolean } } }>
    }
    expect(artifact.runOutcome).toBe('failed')
    expect(artifact.cleanup).toBe(true)
    expect(artifact.activeCredentialCount).toBe(0)
    // Native canceled is distinct from closure without an accepted terminal.
    // The latter stays failed/nonretryable unless the Run has a persisted Stop.
    expect(artifact.executions.find((item) => item.id === interruptedExecutionId)?.result?.outcome).toBe('canceled')
    const sibling = originalBranches.find((item) => item.execution_id !== interruptedExecutionId)!
    expect(artifact.executions.find((item) => item.id === sibling.execution_id)?.result).toMatchObject({
      outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: false },
    })
    for (const original of originalBranches) expect(artifact.executions.find((item) => item.id === original.execution_id)?.nativeSessionId).toBe(original.native_session_id)
    expect(fault).toBeDefined()
    await writeFile(result.artifactPath.replace('.json', '-fault.json'), JSON.stringify({
      scenario: 'E03-L02', mode: 'native internal abnormal task-owned cgroup exit',
      runId: artifact.runId, interruptedExecutionId, fault, providerEvidence: result.artifactPath,
      expected: { runOutcome: 'failed', reviewerStarted: false, cleanup: true },
      actual: { runOutcome: artifact.runOutcome, interruptedOutcome: 'canceled', cleanup: artifact.cleanup,
        activeCredentialCount: artifact.activeCredentialCount },
    }, null, 2))
  }, 180_000)

  it('E03-L03 repeats Start and reconcile during two live turns without extra native submissions', async () => {
    let submissionCounts: number[] = []
    const result = await runEng03NativeScenario('E03-L03', 'codex', 'codex', {
      control: async (context) => {
        const { pool, runId, nodeIds, engine, startTask } = context
        await startedBranches(context)
        expect(engine.start(runId)).toBe(startTask)
        await engine.reconcile()
        expect(engine.start(runId)).toBe(startTask)
        await startTask
        submissionCounts = (await pool.query<{ workflow_node_id: string; turns: number }>(
          `select he.workflow_node_id,count(distinct ne.record->'payload'->>'turnId')::int as turns
           from harness_executions he join harness_native_events ne on ne.execution_id=he.id
           where he.run_id=$1 and he.workflow_node_id=any($2::text[]) and ne.record->>'type'='turn.started'
           group by he.workflow_node_id order by he.workflow_node_id`,
          [runId, [nodeIds[1], nodeIds[2]]],
        )).rows.map((row) => row.turns)
        expect(submissionCounts).toEqual([1, 1])
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; executions: Array<{ nodeId: string; nativeSessionId?: string }>
    }
    expect(artifact.runOutcome).toBe('succeeded')
    expect(artifact.cleanup).toBe(true)
    expect(submissionCounts).toEqual([1, 1])
    expect(artifact.executions).toHaveLength(4)
    expect(new Set(artifact.executions.map((item) => item.nativeSessionId)).size).toBe(4)
  }, 180_000)

  it('E03-L04 reobserves one active native turn on its exact session without another submission', async () => {
    let observed: { executionId: string; nativeSessionId: string; nativeTurnId: string } | undefined
    const result = await runEng03NativeScenario('E03-L04', 'codex', 'codex', {
      prompts: {
        A: 'Read the accepted Entry result. Without tools or files, list n and n squared modulo 97 for n=1 through 60. End with A-OBSERVED.',
        B: 'Read the accepted Entry result. Without tools or files, list n and n cubed modulo 101 for n=1 through 60. End with B-OBSERVED.',
        Reviewer: 'Read both accepted predecessor results and return exactly OBSERVATION-COMPLETE. Do not use tools or files.',
      },
      control: async (context) => {
        const { pool, runId, nodeIds, runs, approvals, startTask } = context
        const started = await startedBranches(context)
        const execution = (await readCurrentExecutions(runs, runId)).find((item) => item.id === started[0]!.execution_id)!
        const sessions = Reflect.get(approvals, 'ownedSessions') as Map<string, {
          session?: NativeSessionReference; manager: SingleWriterSessionManager
        }>
        const owned = sessions.get(execution.id)
        expect(owned?.session?.nativeSessionId).toBe(execution.nativeSessionId)
        expect(owned!.manager.isActive(owned!.session!)).toBe(true)
        const correlationId = `execution:${execution.id}`
        const history = await owned!.manager.reconcile(owned!.session!, correlationId, AbortSignal.timeout(20_000))
        expect(history.correlationId).toBe(correlationId)
        expect(history.nativeTurnId).toBeTruthy()
        observed = { executionId: execution.id, nativeSessionId: owned!.session!.nativeSessionId,
          nativeTurnId: history.nativeTurnId! }
        await startTask
        const turns = await pool.query<{ count: number }>(
          `select count(distinct record->'payload'->>'turnId')::int as count from harness_native_events
           where execution_id=$1 and record->>'type'='turn.started'`, [execution.id],
        )
        expect(turns.rows[0]?.count).toBe(1)
        expect((await runs.getExecution(execution.id))?.nativeSessionId).toBe(observed.nativeSessionId)
        expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
          [runId, nodeIds[3]])).rowCount).toBe(1)
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as { runOutcome: string; cleanup: boolean }
    expect(artifact.runOutcome).toBe('succeeded')
    expect(artifact.cleanup).toBe(true)
    expect(observed).toBeDefined()
    await writeFile(result.artifactPath.replace('.json', '-observation.json'), JSON.stringify({
      scenario: 'E03-L04', mode: 'native internal active same-session reobservation',
      providerEvidence: result.artifactPath, observed, distinctNativeTurns: 1,
      runOutcome: artifact.runOutcome, cleanup: artifact.cleanup,
    }, null, 2))
  }, 180_000)

  it('E03-L04 restarts after one native terminal result but before its graph acceptance', async () => {
    let cutExecutionId = '', cutNativeSessionId = ''
    let cutResult: unknown
    let acceptedSiblingId = '', beforeNativeEventCount = -1, afterNativeEventCount = -1
    const result = await runEng03NativeScenario('E03-L04', 'codex', 'codex', {
      prompts: {
        A: 'Read the accepted Entry result. Without tools or files, list n and n squared for n=1 through 25. End with A-RECOVERY.',
        B: 'Read the accepted Entry result. Without tools or files, list n and n cubed for n=1 through 30. End with B-RECOVERY.',
        Reviewer: 'Read the two accepted predecessor results and return exactly RECOVERED. Do not use tools or files.',
      },
      control: async ({ pool, runId, nodeIds, runs, startTask, restartRecoverableRuntime }) => {
        const original = RepeatRunRepository.prototype.acceptTerminal
        let injected = false
        const spy = vi.spyOn(RepeatRunRepository.prototype, 'acceptTerminal').mockImplementation(
          async function (this: RepeatRunRepository, ...args: Parameters<RepeatRunRepository['acceptTerminal']>) {
            const [executionId] = args
            const row = (await pool.query<{ workflow_node_id: string; accepted: boolean; record: unknown }>(
              'select workflow_node_id,accepted,record from harness_executions where id=$1 and run_id=$2',
              [executionId, runId],
            )).rows[0]
            if (row && !injected && [nodeIds[1], nodeIds[2]].includes(row.workflow_node_id)) {
              const sibling = await pool.query(
                `select 1 from harness_executions where run_id=$1 and id<>$2
                 and workflow_node_id=any($3::text[]) and accepted=true limit 1`,
                [runId, executionId, [nodeIds[1], nodeIds[2]]],
              )
              const execution = HarnessExecutionSchema.parse(row.record)
              if (sibling.rowCount && !row.accepted && execution.state === 'completed'
                && execution.result?.outcome === 'succeeded' && execution.nativeSessionId) {
                injected = true
                cutExecutionId = executionId
                cutNativeSessionId = execution.nativeSessionId
                cutResult = execution.result
                throw new Error('ENG03_C_ACCEPTANCE_CUT')
              }
            }
            return original.apply(this, args)
          },
        )
        try {
          await startTask.catch(() => undefined)
          expect(injected).toBe(true)
          expect((await runs.get(runId))?.executionState).toBe('running')
          const before = (await runs.getExecution(cutExecutionId))!
          expect(before).toMatchObject({ state: 'completed', nativeSessionId: cutNativeSessionId, result: cutResult })
          const accepted = await pool.query<{ id: string }>(
            `select id from harness_executions where run_id=$1 and accepted=true
             and workflow_node_id=any($2::text[])`, [runId, [nodeIds[1], nodeIds[2]]],
          )
          expect(accepted.rowCount).toBe(1)
          acceptedSiblingId = accepted.rows[0]!.id
          const beforeEvents = (await pool.query<{ count: number }>(
            'select count(*)::int as count from harness_native_events where execution_id=$1', [cutExecutionId],
          )).rows[0]!.count
          beforeNativeEventCount = beforeEvents
          spy.mockRestore()
          const next = await restartRecoverableRuntime()
          expect((await next.runs.getExecution(cutExecutionId))?.nativeSessionId).toBe(cutNativeSessionId)
          await next.engine.reconcile()
          await next.engine.start(runId)
          expect((await next.runs.get(runId))?.outcome).toBe('succeeded')
          expect((await next.runs.getExecution(cutExecutionId))?.result).toEqual(cutResult)
          const after = await pool.query<{ accepted: boolean }>('select accepted from harness_executions where id=$1', [cutExecutionId])
          expect(after.rows[0]?.accepted).toBe(true)
          const afterEvents = (await pool.query<{ count: number }>(
            'select count(*)::int as count from harness_native_events where execution_id=$1', [cutExecutionId],
          )).rows[0]!.count
          afterNativeEventCount = afterEvents
          expect(afterEvents).toBe(beforeEvents)
          expect((await pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2',
            [runId, nodeIds[3]])).rowCount).toBe(1)
        } finally { spy.mockRestore() }
      },
    })
    const artifact = JSON.parse(await readFile(result.artifactPath, 'utf8')) as {
      runOutcome: string; cleanup: boolean; runtimeRestart?: { kind: string; preservedNativeSessionIds: string[] }
      finalText: string; joinExact: boolean; sourceGraph: { nodes: Array<{ id: string }> }
      executions: Array<{ id: string; nodeId: string; nativeSessionId?: string; result?: unknown; input: unknown }>
      bindings: RepeatInputBinding[]
    }
    expect(artifact.runOutcome).toBe('succeeded')
    expect(artifact.cleanup).toBe(true)
    expect(artifact.runtimeRestart?.kind).toBe('terminal_unaccepted')
    expect(artifact.runtimeRestart?.preservedNativeSessionIds).toContain(cutNativeSessionId)
    expect(artifact.executions.find((item) => item.id === cutExecutionId)?.result).toEqual(cutResult)
    expect(artifact.finalText).toBe('RECOVERED')
    expect(artifact.joinExact).toBe(true)
    const reviewer = artifact.executions.find((item) => item.nodeId === artifact.sourceGraph.nodes[3]?.id)!
    const input = reviewer.input as RepeatNodeInput
    expect(input.predecessors).toHaveLength(2)
    expect(artifact.bindings).toHaveLength(2)
    const recipientInputDigest = repeatDigest(reviewer.input)
    for (const [ordinal, predecessor] of input.predecessors.entries()) {
      const sender = artifact.executions.find((item) => item.id === predecessor.execution.executionId)!
      const binding = artifact.bindings.find((item) => 'relationshipId' in item.source && item.source.relationshipId === predecessor.relationshipId)!
      expect(predecessor.acceptedResult).toEqual(sender.result)
      expect(binding).toMatchObject({ ordinal, source: { execution: { executionId: sender.id }, acceptedResultDigest: repeatDigest(sender.result) },
        recipient: { executionId: reviewer.id }, inputDigest: recipientInputDigest })
    }
    expect(beforeNativeEventCount).toBeGreaterThan(0)
    expect(afterNativeEventCount).toBe(beforeNativeEventCount)
    await writeFile(result.artifactPath.replace('.json', '-recovery.json'), JSON.stringify({
      scenario: 'E03-L04', mode: 'native internal post-terminal recovery', providerEvidence: result.artifactPath,
      recovered: true, runOutcome: artifact.runOutcome, cleanup: artifact.cleanup,
      acceptedSiblingId, cutExecutionId, cutNativeSessionId, cutResultDigest: repeatDigest(cutResult),
      nativeEventCountBeforeRestart: beforeNativeEventCount, nativeEventCountAfterRestart: afterNativeEventCount,
      reviewerExecutionId: reviewer.id, reviewerInputDigest: recipientInputDigest,
      bindings: artifact.bindings,
      finalText: artifact.finalText,
    }, null, 2))
  }, 180_000)
})
