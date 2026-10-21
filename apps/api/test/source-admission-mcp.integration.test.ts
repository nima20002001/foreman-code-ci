import { OperatorSourceListResultSchema, decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { ManagementActionSchema, OperatorCapabilitiesSchema } from '@foreman-code/contracts/management'
import { SourceApproveResultSchema, SourceListResultSchema, ApprovedSourceSchema, SourceRootBindResultSchema, SourceRootListResultSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { PostgresWorkspaceRootPolicies } from '../src/modules/sources/rootPolicies.js'
import { InstalledWorkspaceRootHosts } from '../src/modules/sources/rootHosts.js'
import { RegisteredWorkspaceSourceRoots } from '../src/modules/sources/registeredSourceRoots.js'
import { qualifyApprovedRootAllowlist } from '../src/modules/sources/rootAttestation.js'
import { qualifiedGit } from '../src/modules/sources/capture.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'

/** Root-only DB fixture: real authenticated /mcp, actual workspace/installation,
 * canonical Git capture and persisted readback. The fixture registered-root
 * authority uses the real generic policy/host helper modules; native/remote execution is intentionally not invoked.
 */
it.skipIf(!process.env.TEST_DATABASE_URL)('admits exact approved sources and roots through authenticated MCP without caller paths or fake Run/Agent', async () => {
  const connectionString = process.env.TEST_DATABASE_URL!
  const url = new URL(connectionString)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) throw new Error('Use an owned disposable loopback test database.')
  const schema = `source_mcp_${randomUUID().replaceAll('-', '')}`, directory = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/source-mcp-`)
  const admin = new pg.Pool({ connectionString }); await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  const clients: Client[] = []
  const commands = new PostgresCommandCoordinator(pool), access = new PostgresAccessService(pool)
  const project = join(directory, 'project'), canonical = join(directory, 'canonical-source'), runtime = join(directory, 'runtime')
  for (const path of [project, canonical, runtime]) await mkdir(path, { mode: 0o700 })
  const locations = new WorkspaceLocationService(pool, commands, runtime, 'runner-local')
  const workspaces = new WorkspaceManagementService(pool, commands, locations)
  let app: ReturnType<typeof buildApp> | undefined
  try {
    await applyApplicationMigrations(pool)
    const mainId = (await pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
    const owner = await access.issue({ name: 'Source owner', audience: 'operator', grants: [{ actions: [...ManagementActionSchema.options], scope: {} }], expiresAt: new Date(Date.now() + 300_000) })
    const created = await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Source workspace' })
    const workspace = created.value.workspace
    await workspaces.update(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedRevision: created.value.revision,
      repository: { provider: 'github', owner: 'original', name: 'site', defaultBranch: 'main' } })
    const located = await locations.set(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(), expectedLocationRevision: created.value.locationRevision, runnerId: locations.runnerId, rootPath: project })
    await qualifiedGit(project, ['init', '--template=']); await writeFile(join(project, 'source.ts'), 'export const revision = 1\n')
    await writeFile(join(project, 'run.sh'), '#!/bin/sh\nexit 0\n')
    await chmod(join(project, 'run.sh'), 0o755)
    await qualifiedGit(project, ['add', '.']); await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source1'])
    const commit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
    const nativeNotInvoked = async (): Promise<never> => { throw new Error('This source metadata fixture does not invoke native execution.') }
    const approvedRoots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
    const hosts = new InstalledWorkspaceRootHosts(approvedRoots, async (sql, _principal, host, installationId) => {
      const main = (await sql.query<{ id: string }>('select id from application_installation where singleton=true for share')).rows[0]
      if (host.kind !== 'main' || host.mainId !== main?.id || installationId !== main.id) throw new Error('Wrong actual main installation.')
      return null
    }, { request: nativeNotInvoked })
    const policies = new PostgresWorkspaceRootPolicies(mainId, hosts)
    const authorized = await withTransaction(pool, async sql => {
      await policies.publishApprovedHostConfiguration(sql, approvedRoots, { mainId, hostRef: approvedRoots.hostRef, applicationInstallationId: mainId,
        configurationRevision: '1', configurationDigest: sourceSha256(Buffer.from(JSON.stringify(approvedRoots))) })
      return policies.authorize(sql, owner.principal, { workspaceId: workspace.id, hostRef: approvedRoots.hostRef,
        allowedBaseId: approvedRoots.bases[0]!.baseId, configurationRevision: '1', relativePath: '', accessMode: 'read-write', expectedLocationRevision: located.value.locationRevision, expectedRootPolicyRevision: 0 })
    })
    const attestation = await policies.attest(authorized)
    const policy = await withTransaction(pool, async bindingSql => {
      await policies.fence(bindingSql, authorized)
      await bindingSql.query('update workspaces set location_revision=location_revision+1 where id=$1 and location_revision=$2', [workspace.id, located.value.locationRevision])
      return policies.bind(bindingSql, owner.principal, authorized, attestation, located.value.locationRevision + 1)
    })
    const roots = new RegisteredWorkspaceSourceRoots(policies, hosts)
    const createSources = () => new PostgresSourceService(pool, new PostgresCommandCoordinator(pool), locations, new PrivateSourceSnapshotStore(canonical), mainId, roots,
      { authorize: nativeNotInvoked, prepare: nativeNotInvoked, verifyWorkingDirectory: nativeNotInvoked, verify: nativeNotInvoked, releaseClaim: nativeNotInvoked, authorizeFinal: nativeNotInvoked }, { confirmedClosed: nativeNotInvoked })
    let sources = createSources()
    const services = { commands, workspaces, locations, sources } as unknown as OperatorServices
    app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } }, operator: { access, services } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const operator = await access.issue({ name: 'Scoped source Operator', audience: 'operator', grants: [{ actions: ['capabilities:read', 'sources:read', 'source_roots:read', 'source_roots:bind', 'workspace_locations:read'], scope: { workspaceIds: [workspace.id] } }], expiresAt: new Date(Date.now() + 240_000) })
    await pool.query('update management_principals set delegated_from=$2 where id=$1', [operator.principal.id, owner.principal.id])
    async function connect(token: string) { const client = new Client({ name: 'source-fixture', version: '1.0.0' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
    const client = await connect(operator.token)
    const approve = { workspaceId: workspace.id, commandId: randomUUID(), expectedLocationRevision: Number(policy.locationRevision), commit, executablePolicy: 'strip' }
    const tools = await client.listTools()
    expect(tools.tools.find(tool => tool.name === 'source_approve')?.inputSchema.properties)
      .not.toHaveProperty('approveTrackedTree')
    const capabilities = await client.callTool({ name: 'operator_get_capabilities',
      arguments: { workspaceId: workspace.id, detail: 'full' } })
    expect(capabilities.isError).not.toBe(true)
    const { runtimeLimits } = OperatorCapabilitiesSchema.parse(decodeMcpToolResult(capabilities))
    expect(runtimeLimits?.find(limit => limit.feature === 'source_approval')?.detail)
      .toContain('without path approvals')
    const failure = (response: Awaited<ReturnType<Client['callTool']>>) => {
      expect(response.isError).toBe(true)
      const text = (response.content as { type: string; text?: string }[]).find(item => item.type === 'text')!.text!
      return JSON.parse(text).error
    }
    await writeFile(join(project, '.env'), 'SECRET=fixture\n')
    await qualifiedGit(project, ['add', '.env'])
    await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'sensitive source'])
    const sensitiveCommit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
    const sensitiveRequest = { ...approve, commandId: randomUUID(), commit: sensitiveCommit }
    expect(failure(await client.callTool({ name: 'source_approve', arguments: sensitiveRequest })))
      .toMatchObject({ code: 'SOURCE_SENSITIVE_PATH' })
    const httpError = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspace.id}/sources/approve`,
      headers: { authorization: `Bearer ${operator.token}` },
      payload: { ...sensitiveRequest, commandId: randomUUID() } })
    expect(httpError.statusCode).toBe(400)
    expect(httpError.json().error).toMatchObject({ code: 'SOURCE_SENSITIVE_PATH' })
    await qualifiedGit(project, ['rm', '-f', '.env'])
    const firstCall = await client.callTool({ name: 'source_approve', arguments: approve })
    expect(firstCall.isError, JSON.stringify(firstCall)).not.toBe(true)
    const first = SourceApproveResultSchema.parse(decodeMcpToolResult(firstCall))
    expect(firstCall.structuredContent).toBeUndefined()
    expect(firstCall.content).toEqual([{ type: 'text', text: JSON.stringify(first) }])
    const compact = await client.callTool({ name: 'source_list', arguments: { workspaceId: workspace.id } })
    const summaries = OperatorSourceListResultSchema.parse(decodeMcpToolResult(compact))
    expect(summaries).toMatchObject({ detail: 'compact', items: [{ detailsOmitted: true,
      manifest: { snapshotId: first.value.manifest.snapshotId, manifestDigest: first.value.manifest.manifestDigest,
        totalEntries: 2 } }] })
    expect(summaries.items[0]!.manifest).not.toHaveProperty('entries')
    expect(summaries.items[0]!.manifest).not.toHaveProperty('deletions')
    const full = SourceListResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'source_list', arguments: { workspaceId: workspace.id, detail: 'full' },
    })))
    expect(full.items).toEqual([first.value])
    expect(first.value.manifest.entries.map(entry => entry.path)).toEqual(['run.sh', 'source.ts'])
    expect(first.value.manifest.entries.every(entry => !entry.executable)).toBe(true)
    const storedApproval = (await pool.query<{ request: unknown; origin: { approvedPaths: string[] } }>(
      'select request,origin from source_approvals where requested_by=$1 and command_id=$2',
      [operator.principal.id, approve.commandId])).rows[0]!
    expect(storedApproval.request).toEqual(approve)
    expect(storedApproval.origin.approvedPaths).toEqual(['run.sh', 'source.ts'])
    const approvalAudit = (await pool.query<{ count: number }>(
      `select count(*)::int as count from management_audit where principal_id=$1
        and action='source.approve' and outcome='succeeded' and details->>'commandId'=$2`,
      [operator.principal.id, approve.commandId])).rows[0]!
    expect(approvalAudit.count).toBe(1)
    const replay = SourceApproveResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_approve', arguments: approve }))))
    expect(replay.replayed).toBe(true); expect(replay.value).toEqual(first.value)
    const pin = { approvedSourceId: first.value.manifest.approvedSourceId, snapshotId: first.value.manifest.snapshotId, manifestDigest: first.value.manifest.manifestDigest }
    const read = ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } }))))
    expect(read.manifest.git?.commit).toBe(commit)
    expect(read.manifest.git?.repository).toBe('original/site')
    expect(read.manifest.git?.metadata).toMatchObject({ byteSize: expect.any(Number), sha256: expect.any(String) })
    const beforeEdit = await workspaces.get(owner.principal, workspace.id)
    const changed = await workspaces.update(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedRevision: beforeEdit.revision,
      repository: { provider: 'github', owner: 'other', name: 'site', defaultBranch: 'main' } })
    await workspaces.update(owner.principal, 'http', { workspaceId: workspace.id, commandId: randomUUID(),
      expectedRevision: changed.value.revision, repository: null })
    const retained = ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get',
      arguments: { workspaceId: workspace.id, ...pin } }))))
    expect(retained.manifest.git?.repository).toBe('original/site')
    expect(retained.manifest).toEqual(read.manifest)
    const bind = { workspaceId: workspace.id, commandId: randomUUID(), source: pin, selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision }, expectedBindingRevision: 0, accessMode: 'exclusive-write' }
    await pool.query(`create function reject_root_receipt() returns trigger language plpgsql as $$
      begin
        if new.operation='source.root.bind' then raise exception 'Receipt persistence interrupted'; end if;
        return new;
      end $$`)
    await pool.query(`create trigger interrupt_root_receipt before insert on management_command_receipts
      for each row execute function reject_root_receipt()`)
    const interruptedBind = await client.callTool({ name: 'source_root_bind', arguments: bind })
    expect(interruptedBind.isError).toBe(true)
    expect(SourceRootListResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_root_list',
      arguments: { workspaceId: workspace.id } })))).items).toEqual([])
    expect((await pool.query('select count(*)::int as count from source_root_bindings')).rows[0].count).toBe(0)
    await pool.query('drop trigger interrupt_root_receipt on management_command_receipts')
    await pool.query('drop function reject_root_receipt()')
    sources = createSources()
    services.sources = sources
    const rootResult = await client.callTool({ name: 'source_root_bind', arguments: bind })
    expect(rootResult.isError, JSON.stringify(rootResult)).not.toBe(true)
    const bound = SourceRootBindResultSchema.parse(decodeMcpToolResult(rootResult)).value
    expect(bound.binding.deviceId).toBeNull(); expect(bound.binding.workerInstallationId).toBeNull()
    const rootRead = SourceRootRecordSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_root_get', arguments: { workspaceId: workspace.id, rootId: bound.binding.rootId, bindingRevision: 1 } }))))
    expect(rootRead).toEqual(bound)
    const extraRootId = randomUUID()
    const extra = SourceRootRecordSchema.parse({ ...bound, binding: { ...bound.binding, rootId: extraRootId } })
    await pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash) values($1,$2,$3)',
      [extraRootId, workspace.id, sourceSha256(Buffer.from(extraRootId))])
    await pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,1,$2,$3,$4::jsonb)',
      [extraRootId, workspace.id, pin.snapshotId, JSON.stringify(extra)])
    await pool.query('update source_root_catalog set current_binding_revision=1 where root_id=$1', [extraRootId])
    const headers = { authorization: `Bearer ${operator.token}` }
    const rootUrl = `/api/management/workspaces/${workspace.id}/source-roots`
    const httpRoots = await app.inject({ method: 'GET', url: `${rootUrl}?limit=1`, headers })
    expect(httpRoots.statusCode).toBe(200)
    const limited = SourceRootListResultSchema.parse(httpRoots.json())
    expect(limited.items).toHaveLength(1)
    const mcpLimited = SourceRootListResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'source_root_list', arguments: { workspaceId: workspace.id, limit: 1 },
    })))
    expect(limited).toEqual(mcpLimited)
    expect(SourceRootListResultSchema.parse((await app.inject({ method: 'GET', url: rootUrl, headers })).json()).items)
      .toHaveLength(2)
    for (const limit of ['0', '-1', '101', '1.5', 'invalid', '']) {
      const rejected = await app.inject({ method: 'GET', url: `${rootUrl}?limit=${limit}`, headers })
      expect(rejected.statusCode).toBe(400)
      expect(rejected.json().error.code).toBe('INVALID_REQUEST')
      expect((await client.callTool({ name: 'source_root_list',
        arguments: { workspaceId: workspace.id, limit: Number(limit) } })).isError).toBe(true)
    }
    const sourceReader = await access.issue({ name: 'Source reader without locations', audience: 'operator',
      grants: [{ actions: ['sources:read', 'source_roots:read'], scope: { workspaceIds: [workspace.id] } }],
      expiresAt: new Date(Date.now() + 120_000) })
    const sourceReaderClient = await connect(sourceReader.token)
    const readerTools = await sourceReaderClient.listTools()
    expect(readerTools.tools.map(tool => tool.name)).not.toContain('source_root_get')
    expect(readerTools.tools.map(tool => tool.name)).not.toContain('source_root_list')
    const rootInput = { workspaceId: workspace.id, rootId: bound.binding.rootId, bindingRevision: 1 }
    for (const name of ['source_root_get', 'source_root_list']) {
      const deniedRead = await sourceReaderClient.callTool({ name,
        arguments: name === 'source_root_get' ? rootInput : { workspaceId: workspace.id } })
      expect(deniedRead.isError).toBe(true)
      expect(JSON.stringify(deniedRead.content)).not.toContain(bound.binding.canonicalPath)
    }
    const deniedRootGet = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspace.id}/source-roots/get`,
      headers: { authorization: `Bearer ${sourceReader.token}` }, payload: rootInput })
    const deniedRootList = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${workspace.id}/source-roots`,
      headers: { authorization: `Bearer ${sourceReader.token}` } })
    for (const response of [deniedRootGet, deniedRootList]) {
      expect(response.statusCode).toBe(403)
      expect(response.json().error.code).toBe('ACCESS_DENIED')
      expect(response.body).not.toContain(bound.binding.canonicalPath)
    }
    const replayedBind = await client.callTool({ name: 'source_root_bind', arguments: bind })
    expect(SourceRootBindResultSchema.parse(decodeMcpToolResult(replayedBind))).toEqual({ value: bound, replayed: true })
    const bindingAudit = await pool.query<{ count: number }>(`select count(*)::int as count from management_audit
      where principal_id=$1 and action='source.root.bind' and outcome='succeeded' and details->>'commandId'=$2`,
    [operator.principal.id, bind.commandId])
    expect(bindingAudit.rows[0]!.count).toBe(1)

    const unchangedRevision = await client.callTool({ name: 'source_root_bind', arguments: {
      ...bind, commandId: randomUUID(),
    } })
    expect(unchangedRevision.isError).toBe(true)
    expect(JSON.stringify(unchangedRevision.content)).toContain('SOURCE_ROOT_REVISION_CONFLICT')
    const ignoredInput = { ...approve, commandId: randomUUID(), rootPath: '/unrelated/source',
      runId: 'invented', agentId: 'invented' }
    const wrongHttp = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspace.id}/sources/approve`, headers, payload: ignoredInput })
    expect(wrongHttp.statusCode).toBe(400)
    const tolerated = await client.callTool({ name: 'source_approve', arguments: ignoredInput })
    expect(tolerated.isError, JSON.stringify(tolerated)).not.toBe(true)
    const captured = SourceApproveResultSchema.parse(decodeMcpToolResult(tolerated)).value
    expect(captured.workspaceId).toBe(workspace.id)
    expect(captured.locationRevision).toBe(read.locationRevision)
    expect(captured.originIdentityHash).toBe(read.originIdentityHash)
    expect(captured.manifest.git).toEqual({
      commit,
      tree: read.manifest.git!.tree,
      objectFormat: read.manifest.git!.objectFormat,
      metadata: read.manifest.git!.metadata,
    })
    expect(captured.manifest.entries).toEqual(read.manifest.entries)
    expect(ApprovedSourceSchema.parse(decodeMcpToolResult(await client.callTool({ name: 'source_get',
      arguments: { workspaceId: workspace.id, approvedSourceId: captured.manifest.approvedSourceId,
        snapshotId: captured.manifest.snapshotId, manifestDigest: captured.manifest.manifestDigest },
    })))).toEqual(captured)
    const denied = await access.issue({ name: 'Other scope', audience: 'operator', grants: [{ actions: ['sources:read', 'source_roots:bind', 'workspace_locations:read'], scope: { workspaceIds: ['workspace-other'] } }], expiresAt: new Date(Date.now() + 120_000) })
    const deniedClient = await connect(denied.token)
    expect(failure(await deniedClient.callTool({ name: 'source_approve',
      arguments: { ...approve, commandId: randomUUID() } }))).toMatchObject({ code: 'ACCESS_DENIED' })
    expect(ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get',
      arguments: { workspaceId: workspace.id, ...pin } }))))).toEqual(read)
    expect(Number((await pool.query<{ count: string }>(`select count(*) from management_audit where principal_id=$1 and outcome='denied'`, [denied.principal.id])).rows[0]!.count)).toBeGreaterThan(0)
    const reader = await access.issue({ name: 'Read-only source', audience: 'operator', grants: [{ actions: ['sources:read', 'workspace_locations:read'], scope: { workspaceIds: [workspace.id] } }], expiresAt: new Date(Date.now() + 120_000) })
    const readerClient = await connect(reader.token)
    expect((await readerClient.listTools()).tools.map(t => t.name)).not.toContain('source_approve')
    const beforeDenied = await sources.list(owner.principal, 'mcp', { workspaceId: workspace.id })
    expect((await readerClient.callTool({ name: 'source_approve',
      arguments: { ...approve, commandId: randomUUID() } })).isError).toBe(true)
    expect(await sources.list(owner.principal, 'mcp', { workspaceId: workspace.id })).toEqual(beforeDenied)
    await writeFile(join(project, 'source.ts'), 'export const revision = 2\n'); await qualifiedGit(project, ['add', '.']); await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source2'])
    const newCommit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
    const second = await client.callTool({ name: 'source_approve', arguments: { ...approve, commandId: randomUUID(), commit: newCommit } }); expect(second.isError).not.toBe(true)
    expect(ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } })))).manifest.git?.commit).toBe(commit)
    expect(SourceListResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_list', arguments: { workspaceId: workspace.id, detail: 'full' } })))).items).toHaveLength(3)
    const expectedSnapshots = [read, captured, SourceApproveResultSchema.parse(decodeMcpToolResult(second)).value]
      .map(source => source.manifest.snapshotId).sort()
    const snapshotIds: string[] = []
    let afterSnapshotId: string | null = null
    do {
      const page = OperatorSourceListResultSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'source_list', arguments: { workspaceId: workspace.id, limit: 1,
          ...(afterSnapshotId === null ? {} : { afterSnapshotId }) },
      })))
      expect(page.items).toHaveLength(1)
      snapshotIds.push(page.items[0]!.manifest.snapshotId)
      expect(new Set(snapshotIds).size).toBe(snapshotIds.length)
      expect(snapshotIds.length).toBeLessThanOrEqual(expectedSnapshots.length)
      afterSnapshotId = page.nextSnapshotId
    } while (afterSnapshotId !== null)
    expect(snapshotIds.sort()).toEqual(expectedSnapshots)
    expect(SourceListResultSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_list',
      arguments: { workspaceId: workspace.id, detail: 'full' } })))).items).toHaveLength(3)
    expect(ApprovedSourceSchema.parse(decodeMcpToolResult((await client.callTool({ name: 'source_get',
      arguments: { workspaceId: workspace.id, ...pin } }))))).toEqual(read)
    const http = await app.inject({ method: 'POST', url: `/api/management/workspaces/${workspace.id}/sources/get`, headers: { authorization: `Bearer ${operator.token}` }, payload: pin })
    expect(http.statusCode).toBe(200); expect(ApprovedSourceSchema.parse(http.json()).manifest.manifestDigest).toBe(pin.manifestDigest)
    await pool.query(`update source_snapshots set availability='unavailable' where snapshot_id=$1`, [pin.snapshotId])
    expect((await client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } })).isError).toBe(true)
    expect((await client.callTool({ name: 'source_approve', arguments: approve })).isError).toBe(true)
    await access.revoke(owner.principal.id)
    await expect(access.authenticate(operator.token)).rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 401 })
    await expect(client.callTool({ name: 'source_get', arguments: { workspaceId: workspace.id, ...pin } })).rejects.toThrow('Unauthorized')
  } finally {
    for (const client of clients) {
      await client.close().catch(() => {
        // ignore: MCP session shutdown is best-effort so the remaining fixture cleanup still runs.
      })
    }
    await app?.close(); await pool.end(); await dropFixtureSchema(admin, schema); await admin.end(); await removeFixtureDirectory(directory)
  }
}, 180_000)
