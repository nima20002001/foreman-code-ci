import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { gitFixtureEnvironment } from './gitFixture.js'
import { systemGitWorktreePorts } from '../../src/modules/sources/gitWorktree.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, vi } from 'vitest'
import {
  CurrentWorkflowSaveResultSchema, RunStartV3InputSchema, RunStartV3ResultSchema,
  makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { buildApp } from '../../src/app.js'
import { DomainError } from '../../src/modules/errors.js'
import { RunManagementService } from '../../src/modules/runs/management.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { createCurrentNativeProductionFactory } from '../../src/modules/runs/workflowProduction.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import { WorkspaceBoundLocationService } from '../../src/modules/workspace-roots/service.js'
import { agentWorkflowNode } from './agentWorkflowFixture.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { mixedComputerPlacement } from './mixedComputerPlacement.js'
import { privateFixtureDirectory } from './privateFixtureDirectory.js'

export function toolError(result: Awaited<ReturnType<Client['callTool']>>) {
  expect(result.isError).toBe(true)
  const text = result.content.find(item => item.type === 'text')
  if (!text || text.type !== 'text') throw new Error('Expected an MCP error response')
  return JSON.parse(text.text)
}

export async function fixture(options: { gitSource?: boolean; deviceCount?: 1 | 2; unboundFirstDeviceSource?: boolean; unconfiguredFirstDeviceRoot?: boolean } = {}) {
  let placementProducer: Awaited<ReturnType<typeof mixedComputerPlacement>>['producer'] | undefined
  const base = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'),
    admitPlacementExecutionLocked: async (sql, owner, run, execution, ref, inputDigest) => {
      if (!placementProducer) throw new Error('Placement producer is not initialized')
      await placementProducer.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId)
    } })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  let directory: string | undefined
  try {
    directory = await privateFixtureDirectory('mixed-placement-')
    const placement = await mixedComputerPlacement(base, directory, {
      sourceAccessMode: options.gitSource ? 'exclusive-write' : 'read-only',
      deviceCount: options.deviceCount ?? 1,
      unboundFirstDeviceSource: options.unboundFirstDeviceSource ?? false,
      unconfiguredFirstDeviceRoot: options.unconfiguredFirstDeviceRoot ?? false,
      git: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), objectFormat: 'sha1', repository: 'octo/site' },
    })
    const repositoryRoot = join(directory, 'origin')
    await mkdir(repositoryRoot)
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repositoryRoot, encoding: 'utf8', env: gitFixtureEnvironment(),
    }).trim()
    git('init', '-q', '-b', 'main')
    await writeFile(join(repositoryRoot, 'source.ts'), 'export const approved = true\n')
    git('add', '.')
    git('commit', '-qm', 'Initial source')
    const system = systemGitWorktreePorts(gitFixtureEnvironment())
    placement.sources.git = { cloneDirectory: () => join(directory!, 'clone'),
      git: (args, options) => system.git(args[0] === 'clone'
        ? ['clone', '--no-checkout', repositoryRoot, args.at(-1)!] : args, options) }
    const workspace = (await base.db.pool.query<{ revision: number }>(
      'select revision from workspaces where id=$1', [base.f.scope.workspaceId])).rows[0]!
    await base.services.workspaces.update(base.writer.principal, 'mcp', {
      workspaceId: base.f.scope.workspaceId, commandId: randomUUID(), expectedRevision: Number(workspace.revision),
      repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
    })
    base.services.workflows = new WorkflowManagementService(base.db.pool, base.commands, {
      worktrees: { readyRoot: async () => undefined, sources: placement.sources, roots: placement.policies },
    })
    placementProducer = placement.producer
    await base.client.close()
    await base.app.close()
    // Start admission and readback are real; this external provider boundary
    // refuses native entry so no remote execution is simulated on Main.
    const connection = base.provider.connection.bind(base.provider)
    vi.spyOn(base.provider, 'connection').mockImplementation(() => ({ ...connection(),
      createSession: async () => { throw new DomainError('NATIVE_EXECUTION_UNAVAILABLE', 'Admission-only fixture', 503) },
    }))
    const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
      reportDispatchFailure: (_id, _code, error) => base.dispatchErrors.push(error),
    })({ primaryPool: base.db.pool, commands: base.commands, runs: base.runs, workflows: base.workflows,
      locations: base.locations, engine: base.engine, nativeExecutions: base.native,
      interactions: base.service, checkpointer: base.checkpointer })
    const runs = new RunManagementService(base.db.pool, base.commands, base.runs, base.engine, base.locations, {
      ...binding, startPublication: { ...binding.startPublication, placementAdmission: placement.producer,
        workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }) },
    })
    const services = { ...base.services, runs, runPlacements: placement.reads, sources: placement.sources,
      workspaceRoots: new WorkspaceBoundLocationService(base.db.pool, base.commands, placement.policies) }
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: base.access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'mixed-placement', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(base.writer.token)
    const saveInput = await base.create()
    agentWorkflowNode(saveInput.graph.nodes[1]).placement = placement.remote
    const path = `/api/management/workspaces/${saveInput.workspaceId}/workflows/${saveInput.workflowId}`
    const headers = { authorization: `Bearer ${base.writer.token}` }
    return { base, placement, app, services, client, connect, saveInput, path, headers, repositoryRoot, git,
      async save(via: 'http' | 'mcp') {
        if (via === 'mcp') {
          const result = await client.callTool({ name: 'workflow_save_v3', arguments: saveInput })
          expect(result.isError, JSON.stringify(result)).not.toBe(true)
          return CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(result)).value
        }
        const response = await app!.inject({ method: 'PUT', url: `${path}/definition`, headers, payload: saveInput })
        expect(response.statusCode).toBe(200)
        return CurrentWorkflowSaveResultSchema.parse(response.json()).value
      },
      async start(via: 'http' | 'mcp', input: ReturnType<typeof RunStartV3InputSchema.parse>) {
        if (via === 'mcp') {
          const result = await client.callTool({ name: 'run_start', arguments: input })
          expect(result.isError, JSON.stringify(result)).not.toBe(true)
          return RunStartV3ResultSchema.parse(decodeMcpToolResult(result))
        }
        const response = await app!.inject({ method: 'POST', url: `${path}/runs`, headers, payload: input })
        expect(response.statusCode).toBe(202)
        return RunStartV3ResultSchema.parse(response.json())
      },
      async close() {
        await Promise.allSettled(clients.map(client => client.close()))
        await app!.close()
        await base.close()
        await rm(directory!, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close()))
    await app?.close()
    await base.close()
    if (directory) await rm(directory, { recursive: true, force: true })
    throw error
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
export function startInput(f: Fixture, saved: Awaited<ReturnType<Fixture['save']>>) {
  return RunStartV3InputSchema.parse({ workspaceId: saved.version.workspaceId, workflowId: saved.version.workflowId,
    workflowVersionId: saved.currentVersionId, executionSemanticsVersion: 3, commandId: randomUUID(),
    expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    expectedLocationRevision: f.placement.locationRevision, input: {} })
}

export async function advanceMainSourceBinding(f: Fixture) {
  const rootId = f.placement.local.rootBinding!.rootId
  const row = (await f.base.db.pool.query(`select b.record from source_root_catalog c
    join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision where c.root_id=$1`,
    [rootId])).rows[0]!
  const root = SourceRootRecordSchema.parse(row.record)
  root.binding.bindingRevision += 1
  await f.base.db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,$2,$3,$4,$5::jsonb)`, [rootId, root.binding.bindingRevision, f.saveInput.workspaceId,
    root.source.snapshotId, JSON.stringify(root)])
  await f.base.db.pool.query('update source_root_catalog set current_binding_revision=$2 where root_id=$1',
    [rootId, root.binding.bindingRevision])
}

