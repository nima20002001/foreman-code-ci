import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { ManagementActionSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HostHarnessOverrideListSchema, HostHarnessOverrideSaveResultSchema,
  type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { beforeAll, afterAll, expect, it } from 'vitest'
import { authorizeDeviceHost } from '../src/modules/devices/hostAuthorization.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { HostHarnessOverrideService, type HostHarnessOverrideAuthority } from '../src/modules/harnesses/instanceSettings/service.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { PostgresWorkspaceRootPolicies } from '../src/modules/sources/rootPolicies.js'
import type { WorkspaceRootHostPort } from '../src/modules/sources/rootPolicyPorts.js'
import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

const adoptionTool = 'workspace_root_configuration_adopt'
const hostTools = ['harness_instances_list', 'harness_instance_save', 'harness_instance_check']
const rootActions = ['source_roots:read', 'source_roots:bind', 'workspace_locations:read',
  'workspace_locations:validate', 'workspace_locations:update'] as const
const workspaceId = randomUUID()
const otherWorkspaceId = randomUUID()
let fixture: Awaited<ReturnType<typeof reviewAuthMcpDatabase>>
let profiles: HostHarnessOverrideService
let owner: Client
let saved: HostHarnessOverride

beforeAll(async () => {
  fixture = await reviewAuthMcpDatabase()
  const repository = new HarnessInstanceSettingsRepository(fixture.pool)
  const authority: HostHarnessOverrideAuthority = { authorize: async (principal, action, host, installation, client) => {
    if (!client) throw new Error('Host authorization requires a transaction')
    await authorizeDeviceHost(client, principal, action, host, installation)
  } }
  const checks = new HostHarnessInstanceProfileChecks(repository, new HostHarnessProfileEvidenceRepository(fixture.pool),
    fixture.commands, authority, { qualify: async () => { throw new Error('Discovery must not launch native qualification') } })
  profiles = new HostHarnessOverrideService(repository, fixture.commands, authority, async () => null, checks)
  // No root host I/O is needed: denied adoption stops at authorization, and the saved workspace is unconfigured.
  const roots = new PostgresWorkspaceRootPolicies(fixture.mainId, {} as WorkspaceRootHostPort)
  Object.assign(fixture.services, { harnessInstances: profiles,
    workspaceRoots: new WorkspaceBoundLocationService(fixture.pool, fixture.commands, roots) })
  await fixture.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Discovery workspace' })])
  owner = await connect([{ actions: [...ManagementActionSchema.options], scope: {} }])
  const response = await owner.callTool({ name: 'harness_instance_save', arguments: {
    instanceId: randomUUID(), commandId: randomUUID(), presetId: 'discovery-profile', enabled: false,
    target: { hostRef: { kind: 'main', mainId: fixture.mainId }, applicationInstallationId: fixture.mainId,
      harnessInstallationId: 'fixture-codex', installationFingerprint: 'fixture-installation' },
    configuration: { harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
  } })
  expect(response.isError).not.toBe(true)
  saved = HostHarnessOverrideSaveResultSchema.parse(decodeMcpToolResult(response)).value
})
afterAll(async () => { await profiles?.closeChecks(); await fixture?.close() })

async function connect(grants: ManagementGrant[]) {
  const issued = await fixture.access.issue({ name: 'Discovery authority caller', audience: 'operator',
    grants: [{ actions: ['capabilities:read'], scope: {} }, ...grants] })
  return fixture.connect(issued.token)
}

async function listedNames(client: Client) {
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : {})
    names.push(...page.tools.map(tool => tool.name))
    cursor = page.nextCursor
  } while (cursor)
  return names
}

async function expectDiscovery(client: Client, name: string, available: boolean, resource = {}) {
  for (const detail of [undefined, 'compact', 'full']) {
    const response = await client.callTool({ name: 'operator_get_capabilities', arguments: {
      ...resource, ...(detail ? { detail } : {}),
    } })
    expect(response.isError).not.toBe(true)
    const capabilities = decodeMcpToolResult(response)
    expect((capabilities.tools as string[]).includes(name), `${detail ?? 'default'}: ${name}`).toBe(available)
    if (detail === 'full') {
      const requirements = capabilities.requirements as Array<{ name: string }>
      expect(requirements.some(entry => entry.name === name)).toBe(available)
    }
  }
}

async function expectDenied(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError, name).toBe(true)
  expect(decodeMcpToolResult(result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
}

async function expectHidden(client: Client, name: string) {
  expect(await listedNames(client)).not.toContain(name)
  await expectDiscovery(client, name, false)
  await expectDiscovery(client, name, false, { workspaceId })
  await expectDenied(client, 'operator_tool_schema_get', { name })
}

async function rootReadback() {
  const response = await owner.callTool({ name: 'workspace_root_location_get', arguments: { workspaceId } })
  expect(response.isError).not.toBe(true)
  return decodeMcpToolResult(response)
}

it.each(rootActions)('hides root adoption without %s and preserves the persisted root location', async missing => {
  const client = await connect([{ actions: rootActions.filter(action => action !== missing),
    scope: { workspaceIds: [workspaceId] } }])
  const persisted = await rootReadback()
  expect(persisted).toMatchObject({ workspaceId, evidence: 'unconfigured', executionLocation: null, locationRevision: 0 })
  await expectDenied(client, adoptionTool, { workspaceId, hostRef: { kind: 'main', mainId: fixture.mainId } })
  await expectHidden(client, adoptionTool)
  expect(await rootReadback()).toEqual(persisted)
})

it('requires overlapping workspace grants for root adoption and filters the requested workspace', async () => {
  const disjoint = await connect([
    { actions: ['source_roots:read', 'source_roots:bind'], scope: { workspaceIds: [workspaceId] } },
    { actions: ['workspace_locations:read', 'workspace_locations:validate', 'workspace_locations:update'],
      scope: { workspaceIds: [otherWorkspaceId] } },
  ])
  await expectHidden(disjoint, adoptionTool)
  const allowed = await connect([{ actions: [...rootActions], scope: { workspaceIds: [workspaceId] } }])
  expect(await listedNames(allowed)).toContain(adoptionTool)
  await expectDiscovery(allowed, adoptionTool, true)
  await expectDiscovery(allowed, adoptionTool, true, { workspaceId })
  await expectDiscovery(allowed, adoptionTool, false, { workspaceId: otherWorkspaceId })
  const schema = await allowed.callTool({ name: 'operator_tool_schema_get', arguments: { name: adoptionTool } })
  expect(schema.isError).not.toBe(true)
  expect(decodeMcpToolResult(schema)).toMatchObject({ permissionRequirements: { actions: expect.arrayContaining([...rootActions]) } })
})

it.each(['workflowIds', 'runIds', 'mainIds', 'deviceIds',
  'applicationInstallationIds', 'providerAccountIds'] as const)(
  'hides root adoption when its actions are restricted to %s', async dimension => {
    const client = await connect([{ actions: [...rootActions], scope: { [dimension]: [workspaceId] } }])
    await expectDenied(client, adoptionTool, { workspaceId, hostRef: { kind: 'main', mainId: fixture.mainId } })
    await expectHidden(client, adoptionTool)
  })

it.each(['workspaceIds', 'workflowIds', 'runIds', 'mainIds', 'deviceIds',
  'applicationInstallationIds', 'providerAccountIds'] as const)(
  'hides host harness operations from %s scoped grants and preserves the saved profile', async dimension => {
    const client = await connect([{ actions: ['harnesses:read', 'harnesses:update'],
      scope: { [dimension]: [dimension === 'mainIds' || dimension === 'applicationInstallationIds' ? fixture.mainId : workspaceId] } }])
    const listInput = { hostRef: saved.target.hostRef, applicationInstallationId: saved.target.applicationInstallationId }
    const mutationInput = { instanceId: saved.instanceId, target: saved.target, commandId: randomUUID(),
      expectedRevision: saved.revision, configuration: saved.configuration, presetId: saved.presetId, enabled: false }
    for (const name of hostTools) {
      await expectDenied(client, name, name === 'harness_instances_list' ? listInput : mutationInput)
      await expectHidden(client, name)
    }
    const readback = HostHarnessOverrideListSchema.parse(decodeMcpToolResult(await owner.callTool({
      name: 'harness_instances_list', arguments: listInput,
    })))
    expect(readback.overrides.find(profile => profile.instanceId === saved.instanceId)).toEqual(saved)
  })

it.each([
  ['harnesses:read', 'harnesses:update', 'harness_instances_list'],
  ['harnesses:update', 'harnesses:read', 'harness_instance_save'],
] as const)('keeps unscoped %s usable without treating scoped %s as global', async (global, scoped, visible) => {
  const client = await connect([{ actions: [global], scope: {} },
    { actions: [scoped], scope: { workspaceIds: [workspaceId] } }])
  const listed = await listedNames(client)
  expect(listed.filter(name => hostTools.includes(name))).toEqual([visible])
  await expectDiscovery(client, visible, true, { workspaceId })
  await expectHidden(client, 'harness_instance_check')
})
