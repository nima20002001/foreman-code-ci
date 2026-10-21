import { workerToolServices } from './helpers/workerMcpServices.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { AcceptedRepeatStartV1Schema, AcceptedWorkflowRunV3Schema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { acceptRunAuthority, bindRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { GitCiCommits } from '../src/modules/ci-host/commits.js'
import { HostCiService } from '../src/modules/ci-host/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { snapshotAgentWorktree } from '../src/modules/sources/agentSnapshot.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'

afterEach(() => vi.restoreAllMocks())

describe.runIf(postgresEnabled)('GitHub Run-start sources and Agent CI through authenticated MCP', () => {
  it('approves the fetched tracked tree once, reuses unchanged commits, and preserves historical Runs and saved versions', async () => {
    const f = await fixture({ gitSource: true })
    try {
      f.saveInput.graph.defaultWorktree = { rootBinding: f.placement.local.rootBinding! }
      const saved = await f.save('mcp')
      await writeFile(join(f.repositoryRoot, 'source.ts'), 'fresh default source\n')
      await writeFile(join(f.repositoryRoot, 'new.txt'), 'tracked new file\n')
      f.git('add', '.')
      f.git('commit', '-qm', 'Advance default')
      const head = f.git('rev-parse', 'HEAD')
      const read = async (runId: string) => {
        const pins = []
        for (const node of saved.version.definition.nodes) {
          const response = await f.client.callTool({ name: 'run_node_placement_get', arguments: {
            workspaceId: f.saveInput.workspaceId, workflowId: f.saveInput.workflowId, runId, nodeId: node.id,
          } })
          expect(response.isError, JSON.stringify(response)).not.toBe(true)
          const readback = RunPlacementGetResultSchema.parse(decodeMcpToolResult(response)).readback
          if (readback.evidence !== 'accepted') throw new Error('Expected accepted placement readback')
          const source = readback.placement.source
          if (!('kind' in source) || source.kind !== 'pending') throw new Error('Expected Run-start source pins')
          pins.push({ ...readback, placement: { ...readback.placement, source } })
        }
        return pins
      }
      const input = startInput(f, saved)
      const first = await f.start('mcp', input)
      const firstPins = await read(first.run.id)
      const source = firstPins[0]!.placement!.source
      expect(firstPins.every(pin => pin.placement?.source.snapshotId === source.snapshotId)).toBe(true)
      expect(source.snapshotId).not.toBe(f.placement.source.snapshotId)
      const getSource = async (pin: typeof source) => ApprovedSourceSchema.parse(decodeMcpToolResult(
        await f.client.callTool({ name: 'source_get', arguments: { workspaceId: f.saveInput.workspaceId,
          approvedSourceId: pin.approvedSourceId, snapshotId: pin.snapshotId, manifestDigest: pin.manifestDigest } })))
      const approved = await getSource(source)
      expect(approved.manifest.git?.commit).toBe(head)
      expect(approved.manifest.entries.map(entry => entry.path)).toEqual(['new.txt', 'source.ts'])
      expect(await f.start('mcp', input)).toMatchObject({ run: { id: first.run.id }, replayed: true })
      const second = await f.start('http', { ...input, commandId: randomUUID() })
      expect((await read(second.run.id))[0]!.placement!.source.snapshotId).toBe(source.snapshotId)
      await writeFile(join(f.repositoryRoot, 'source.ts'), 'later default source\n')
      f.git('commit', '-qam', 'Advance again')
      const third = await f.start('mcp', { ...input, commandId: randomUUID() })
      const thirdSource = (await read(third.run.id))[0]!.placement!.source
      expect(thirdSource.snapshotId).not.toBe(source.snapshotId)
      expect((await getSource(thirdSource)).manifest.git?.commit).toBe(f.git('rev-parse', 'HEAD'))
      expect(await read(first.run.id)).toEqual(firstPins)
      const version = (await f.base.db.pool.query<{ record: unknown }>(
        'select record from workflow_versions where id=$1', [saved.version.id])).rows[0]!.record
      expect(version).toEqual(saved.version)
      expect((await f.base.db.pool.query(`select action from management_audit
        where principal_id=$1 and action='source.approve' and outcome='succeeded'`, [f.base.writer.principal.id]))
        .rows.length).toBeGreaterThanOrEqual(2)
      const denied = await f.base.access.issue({ name: 'Start without source binding access', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['runs:start', 'workspace_locations:read',
          'sources:read', 'source_roots:read'], scope: { workspaceIds: [input.workspaceId] } }] })
      const deniedClient = await f.connect(denied.token)
      expect(toolError(await deniedClient.callTool({ name: 'run_start', arguments: {
        ...input, commandId: randomUUID(),
      } })).error.code).toBe('ACCESS_DENIED')
      expect((await f.base.db.pool.query(`select outcome from management_audit
        where principal_id=$1 and outcome='denied'`, [denied.principal.id])).rows.length).toBeGreaterThan(0)
    } finally { await f.close() }
  }, 120_000)

  it('queues unchanged Agent files at their base commit through worker MCP and denies a read-only caller', async () => {
    const saved = makeCurrentWorkflowFixture(randomUUID())
    saved.configurations = saved.configurations.map(configuration => ({ ...configuration,
      graphqlTools: ['context_get', 'ci_run', 'ci_get'] }))
    const f = await codexApprovalRuntime('user', { fixture: saved })
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const workspaceId = f.f.scope.workspaceId
      await f.db.pool.query(`update workspaces set record=record || $2::jsonb where id=$1`,
        [workspaceId, JSON.stringify({ repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' } })])
      await f.db.pool.query('update management_principals set grants=grants || $2::jsonb where id=$1',
        [f.authorizationPrincipalId, JSON.stringify([{ actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS],
          scope: { workspaceIds: [workspaceId] } }])])
      f.f.run = await withExclusiveGraphConnection(f.db.pool, connection => connection.transaction(async sql => {
        const owner = await currentOperatorAuthority(sql, f.authorizationPrincipalId)
        const authority = await acceptRunAuthority(sql, owner.principal)
        const run = AcceptedWorkflowRunV3Schema.parse({ ...f.f.run, id: randomUUID(),
          authorizationPrincipalId: authority.principal.id })
        const version = f.f.version
        const workflow = (await sql.query<{ revision: string }>(
          'select revision from workflows where id=$1', [version.workflowId])).rows[0]!
        const accepted = AcceptedRepeatStartV1Schema.parse({ run, snapshot: {
          request: { workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
            executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: Number(workflow.revision),
            expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
            expectedLocationRevision: run.executionLocation.locationRevision, input: run.input },
          authorizationPrincipalId: authority.principal.id, executable: { version, configurations: f.f.configurations },
          workflow: { id: version.workflowId, workspaceId, revision: Number(workflow.revision),
            currentVersionId: version.id, archived: false, definition: version.definition },
          workspace: { id: workspaceId, archived: false, location: run.executionLocation }, draft: null,
        } })
        const admitted = await insertRepeatRun(sql, accepted, repeatStartPublication)
        await bindRunAuthority(sql, admitted.id, authority)
        return admitted
      }))
      f.f.scope.runId = f.f.run.id
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      if (!interaction) throw new Error('Expected an active Agent')
      const issued = await f.credentials.issueForExecution(interaction.executionId)
      const origin = join(f.db.directory, 'origin')
      await mkdir(origin)
      const environment = gitFixtureEnvironment()
      const git = (cwd: string, ...args: string[]) => execFileSync('/bin/sh',
        ['-c', 'umask 002 && exec git "$@"', 'git', ...args], {
          cwd, env: environment, encoding: 'utf8',
        }).trim()
      git(origin, 'init', '-q', '-b', 'main')
      await writeFile(join(origin, 'source.txt'), 'Agent base source')
      git(origin, 'add', '.')
      git(origin, 'commit', '-qm', 'Run start')
      const baseCommit = git(origin, 'rev-parse', 'HEAD')
      const clone = join(f.db.directory, 'clone')
      const tree = join(f.db.directory, 'agent-tree')
      const system = systemGitWorktreePorts(environment)
      const cloned = await system.git(['clone', '-q', '--no-checkout', '--template=', origin, clone], {
        cwd: f.db.directory, signal: AbortSignal.timeout(30_000),
      })
      expect(cloned.code, cloned.stderr).toBe(0)
      git(clone, 'worktree', 'add', '-b', 'foreman/agent', tree, baseCommit)
      await writeFile(join(origin, 'source.txt'), 'Later default source')
      git(origin, 'commit', '-qam', 'Advance default')
      const ports = { ...system, cloneDirectory: () => clone }
      const commands = new PostgresCommandCoordinator(f.db.pool)
      const snapshots = vi.fn(async (executionId: string) => {
        expect(executionId).toBe(interaction.executionId)
        return { baseCommit, ...await snapshotAgentWorktree(ports, { path: tree, baseCommit }, AbortSignal.timeout(30_000)) }
      })
      const ci = new HostCiService(f.db.pool, commands, new RunCiAuthority(f.db.pool), new GitCiCommits(ports),
        { computers: async () => [], request: async () => { throw new Error('No runner requested in admission test') } }, snapshots)
      const tools = workerToolServices(f.db.pool, commands)
      const { bugReports } = tools
      app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access: f.access, services: { commands, ci, bugReports } as unknown as OperatorServices },
        appMcp: tools.appMcp(f.access, new PostgresAppInteractionService(f.db.pool, f.repository, commands)) })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'Agent source CI', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
        return client
      }
      const agent = await connect(issued.environment.variables.GRAPHQL_MCP_TOKEN!)
      const args = { commandId: randomUUID(), suite: 'build' }
      const response = await agent.callTool({ name: 'ci_run', arguments: args })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      const ticket = CiRunOutputSchema.parse(decodeMcpToolResult(response))
      expect(CiRunOutputSchema.parse(decodeMcpToolResult(await agent.callTool({ name: 'ci_run', arguments: args }))))
        .toEqual(ticket)
      expect(snapshots).toHaveBeenCalledTimes(1)
      const result = CiGetOutputSchema.parse(decodeMcpToolResult(await agent.callTool({ name: 'ci_get', arguments: {
        ticketId: ticket.ticketId,
      } })))
      expect(result.run.commit).toBe(baseCommit)
      expect(result.run).toMatchObject({ workspaceId, suite: 'build', state: 'queued',
        initiator: { principalId: issued.principalId, executionId: interaction.executionId } })
      expect((await f.db.pool.query<{ record: { commit: string } }>('select record from ci_runs where id=$1',
        [ticket.ticketId])).rows[0]!.record.commit).toBe(baseCommit)
      const denied = await f.access.issue({ name: 'CI read only', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } }] })
      expect((await (await connect(denied.token)).callTool({ name: 'ci_run', arguments: {
        ...args, workspaceId, commandId: randomUUID(),
      } })).isError).toBe(true)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await f.close()
    }
  }, 120_000)
})
