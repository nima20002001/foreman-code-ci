import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleOperatorCapabilitiesSchema } from '../src/mcp/operator/tools/workflowSchedules.js'
import { JOB_TOOLS, unavailableJobToolCall } from '../src/mcp/operator/tools/jobs.js'
import { JOB_RUNTIME_TOOLS, unavailableJobRuntimeToolCall } from '../src/mcp/operator/tools/jobRuntimeProfiles.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { createGraphqlMcpServer, roleDeniedToolCall } from '../src/mcp/unified/server.js'

const actions:ManagementAction[]=['job_definitions:read','job_definitions:write','jobs:start','jobs:read','jobs:cancel','job_logs:read','job_artifacts:read','sources:read','source_roots:read',
  'source_roots:bind','workspace_locations:read','workspace_locations:validate','workspace_locations:update']
const readerActions=actions.filter(action=>action.endsWith(':read'))
function principal(jobActions=actions):ManagementPrincipal {
  return {id:'job-discovery',name:'Job discovery',audience:'operator',expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null,
    grants:[{actions:['capabilities:read'],scope:{}},...(jobActions.length?[{actions:jobActions,scope:{workspaceIds:['workspace-a']}}]:[])]}
}
const connections:Array<{client:Client;close:()=>Promise<void>}>=[]
afterEach(async()=>{await Promise.all(connections.splice(0).map(async connection=>{await connection.client.close();await connection.close()}))})
async function fixture(actor=principal(),mounted=true,profiles=true,options: { enrollment?: boolean } = {}) {
  const enrollment = options.enrollment ?? profiles
  // Only discovery handlers execute. Probing or qualifying a host is forbidden in this fixture.
  const choices=vi.fn(async()=>{throw new Error('Discovery must not probe a Job host.')})
  const listProfiles=vi.fn(async()=>{throw new Error('Discovery must not probe a runtime profile.')})
  const readEnrollment = vi.fn(async () => { throw new Error('Discovery must not read CI enrollment.') })
  const updateEnrollment = vi.fn(async () => { throw new Error('Discovery must not change CI enrollment.') })
  const recordDenied=vi.fn(async()=>undefined)
  const services = {
    commands: { recordDenied },
    ...(enrollment ? { ciEnrollment: { read: readEnrollment, update: updateEnrollment } } : {}),
    ...(mounted ? { jobs: { choices } } : {}),
    ...(profiles ? {
      jobRuntimeProfiles: { list: listProfiles },
      ciRuntime: {
        start: async () => { throw new Error('Discovery must not prepare a runtime.') },
        get: async () => { throw new Error('Discovery must not read runtime preparation.') },
      },
    } : {}),
  } as unknown as OperatorServices
  const context={principal:actor,services}
  const server=await createGraphqlMcpServer({role:'operator',principal:actor,operator:services})
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client=new Client({name:'job-capability-tests',version:'1'})
  connections.push({client,close:()=>server.close()});await client.connect(clientTransport)
  const capabilities=async(workspaceId?:string)=>{
    const result=await client.callTool({name:'operator_get_capabilities',arguments:{ ...workspaceId?{workspaceId}:{}, detail: 'full' }})
    expect(result.isError,JSON.stringify(result)).not.toBe(true)
    return ScheduleOperatorCapabilitiesSchema.parse(decodeMcpToolResult(result))
  }
  return {client,context,capabilities,choices,listProfiles,recordDenied,readEnrollment,updateEnrollment}
}
const jobNames=(names:readonly string[])=>names.filter(name=>JOB_TOOLS.some(job=>job===name)).sort()
const runtimeNames=(names:readonly string[])=>names.filter(name=>JOB_RUNTIME_TOOLS.some(tool=>tool===name)).sort()
const call=(name:string)=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})

describe('Job capability summary matches mounted Operator tools',()=>{
  it('discovers exact Job tools and scoped requirements without claiming host qualification',async()=>{
    const f=await fixture(),listed=jobNames((await f.client.listTools()).tools.map(tool=>tool.name))
    expect(listed).toEqual([...JOB_TOOLS].sort())
    const listedRuntime=runtimeNames((await f.client.listTools()).tools.map(tool=>tool.name))
    expect(listedRuntime).toEqual([...JOB_RUNTIME_TOOLS].sort())
    for(const scope of [undefined,'workspace-a']) {
      const capabilities=await f.capabilities(scope)
      expect(jobNames(capabilities.tools)).toEqual(listed)
      expect(jobNames(capabilities.requirements!.map(requirement=>requirement.name))).toEqual(listed)
      expect(runtimeNames(capabilities.tools)).toEqual(listedRuntime)
      expect(runtimeNames(capabilities.requirements!.map(requirement=>requirement.name))).toEqual(listedRuntime)
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({name:'job_start',actions:['jobs:start']}))
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({
        name: 'job_launch_validate', actions: ['jobs:start'],
      }))
      for (const name of ['job_cancellation_recovery_propose', 'job_cancellation_recovery_get', 'job_cancellation_recovery_approve']) {
        expect(capabilities.requirements).toContainEqual(expect.objectContaining({ name, actions: ['jobs:cancel'],
          detail: expect.stringContaining('jobs:cancel') }))
      }
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({
        name: 'ci_enrollment_get', actions: ['job_definitions:read'],
      }))
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({
        name: 'ci_enrollment_update', actions: ['job_definitions:read', 'job_definitions:write',
          'sources:read', 'source_roots:bind', 'source_roots:read',
          'workspace_locations:read', 'jobs:start', 'job_artifacts:read',
          'workspace_locations:validate', 'workspace_locations:update'],
      }))
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({ name: 'job_runtime_profile_save',
        actions: ['job_definitions:write', 'sources:read', 'source_roots:read'] }))
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({ name: 'build_computer_prepare',
        actions: ['job_definitions:read', 'job_definitions:write', 'sources:read',
          'source_roots:bind', 'source_roots:read',
          'workspace_locations:read', 'jobs:start', 'job_artifacts:read'] }))
      const limit=capabilities.runtimeLimits!.find(limit=>limit.feature==='ci_jobs')
      expect(limit).toMatchObject({state:'limited'})
      expect(limit!.detail).toContain('current host-bound CI qualification')
      expect(limit!.detail).toContain('Connecting a computer or listing tools is not qualification')
      expect(limit!.detail).toContain('Auto selects')
      expect(limit!.detail).toContain('owner-reviewed')
      for (const [name, action] of [['job_queue_get', 'jobs:read'], ['job_queue_list', 'jobs:read'], ['job_queue_cancel', 'jobs:cancel']]) {
        expect(capabilities.requirements).toContainEqual(expect.objectContaining({ name, actions: [action] }))
      }
      expect(capabilities.runtimeLimits!.find(limit=>limit.feature==='remote_runners_and_host_browsing')!.detail).not.toContain('No arbitrary host browsing or remote dispatch')
    }
    expect(f.choices).not.toHaveBeenCalled();expect(f.listProfiles).not.toHaveBeenCalled()
    expect(f.readEnrollment).not.toHaveBeenCalled();expect(f.updateEnrollment).not.toHaveBeenCalled()
  })
  it('keeps read-only discovery read-only and retains audited direct-write denial',async()=>{
    const f=await fixture(principal(readerActions)),listed=jobNames((await f.client.listTools()).tools.map(tool=>tool.name))
    expect(listed).toContain('job_get');expect(listed).not.toContain('job_start')
    expect(listed).toContain('job_queue_get')
    expect(listed).toContain('job_queue_list')
    expect(listed).not.toContain('job_queue_cancel')
    expect(listed).not.toContain('job_definition_save');expect(listed).not.toContain('job_cancel')
    const capabilities=await f.capabilities('workspace-a')
    expect(jobNames(capabilities.tools)).toEqual(listed)
    expect(jobNames(capabilities.requirements!.map(requirement=>requirement.name))).toEqual(listed)
    expect(runtimeNames(capabilities.tools)).toEqual(['build_computer_prepare_get','ci_enrollment_get','job_runtime_profile_list','job_runtime_qualification_get'])
    const denied=await unavailableJobToolCall(f.context,call('job_start'))
    expect(denied?.result.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
    expect(f.recordDenied).toHaveBeenCalledWith('job-discovery','mcp','job_start','mcp:job_start')
    const enrollmentDenied = await unavailableJobRuntimeToolCall(f.context, call('ci_enrollment_update'))
    expect(enrollmentDenied?.result.isError).toBe(true)
    expect(JSON.stringify(enrollmentDenied)).toContain('ACCESS_DENIED')
    expect(f.recordDenied).toHaveBeenCalledWith(
      'job-discovery', 'mcp', 'ci_enrollment_update', 'mcp:ci_enrollment_update',
    )
    expect(f.choices).not.toHaveBeenCalled()
  })
  it('does not borrow Job scope from another workspace or advertise absent services',async()=>{
    const scoped=await fixture(),foreign=await scoped.capabilities('workspace-b')
    expect(jobNames(foreign.tools)).toEqual([])
    expect(jobNames(foreign.requirements!.map(requirement=>requirement.name))).toEqual([])
    expect(foreign.runtimeLimits!.some(limit=>limit.feature==='ci_jobs')).toBe(false)
    expect(runtimeNames(foreign.tools)).toEqual([])
    expect(runtimeNames(foreign.requirements!.map(requirement=>requirement.name))).toEqual([])
    for(const f of [await fixture(principal(),false,false),await fixture(principal([]))]) {
      expect(jobNames((await f.client.listTools()).tools.map(tool=>tool.name))).toEqual([])
      const capabilities=await f.capabilities('workspace-a')
      expect(jobNames(capabilities.tools)).toEqual([])
      expect(runtimeNames(capabilities.tools)).toEqual([])
      expect(capabilities.runtimeLimits!.some(limit=>limit.feature==='ci_jobs')).toBe(false)
      expect(f.choices).not.toHaveBeenCalled();expect(f.listProfiles).not.toHaveBeenCalled()
      expect(f.readEnrollment).not.toHaveBeenCalled();expect(f.updateEnrollment).not.toHaveBeenCalled()
    }
    const jobsOnly=await fixture(principal(),true,false),capabilities=await jobsOnly.capabilities('workspace-a')
    expect(runtimeNames((await jobsOnly.client.listTools()).tools.map(tool=>tool.name))).toEqual([])
    expect(runtimeNames(capabilities.tools)).toEqual([])
    expect(capabilities.tools).toContain('job_start')
  })
  it('reports profiles-only tools without Job execution and denies qualification to a reader',async()=>{
    for(const jobActions of [actions,readerActions]) {
      const f=await fixture(principal(jobActions),false),listed=(await f.client.listTools()).tools.map(tool=>tool.name)
      const capabilities=await f.capabilities('workspace-a')
      expect(jobNames(listed)).toEqual([]);expect(jobNames(capabilities.tools)).toEqual([])
      expect(runtimeNames(capabilities.tools)).toEqual(runtimeNames(listed))
      expect(runtimeNames(capabilities.requirements!.map(requirement=>requirement.name))).toEqual(runtimeNames(listed))
      expect(capabilities.runtimeLimits!.some(limit=>limit.feature==='ci_jobs')).toBe(false)
      if(!jobActions.includes('job_definitions:write')) {
        expect(runtimeNames(listed)).toEqual(['build_computer_prepare_get','ci_enrollment_get','job_runtime_profile_list','job_runtime_qualification_get'])
        const denied=await unavailableJobRuntimeToolCall(f.context,call('job_runtime_qualification_run'))
        expect(denied?.result.isError).toBe(true);expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
        expect(f.recordDenied).toHaveBeenCalledWith('job-discovery','mcp','job_runtime_qualification_run','mcp:job_runtime_qualification_run')
      } else expect(runtimeNames(listed)).toEqual([...JOB_RUNTIME_TOOLS].sort())
      expect(f.choices).not.toHaveBeenCalled();expect(f.listProfiles).not.toHaveBeenCalled()
      expect(f.readEnrollment).not.toHaveBeenCalled();expect(f.updateEnrollment).not.toHaveBeenCalled()
    }
  })
  it('withholds enrollment tools when the enrollment service is absent', async () => {
    const f = await fixture(principal(), true, true, { enrollment: false })
    const listed = runtimeNames((await f.client.listTools()).tools.map(tool => tool.name))
    const expected = JOB_RUNTIME_TOOLS.filter(name => !name.startsWith('ci_enrollment_')).sort()
    expect(listed).toEqual(expected)
    const capabilities = await f.capabilities('workspace-a')
    expect(runtimeNames(capabilities.tools)).toEqual(expected)
    expect(runtimeNames(capabilities.requirements!.map(requirement => requirement.name))).toEqual(expected)
    expect(f.readEnrollment).not.toHaveBeenCalled()
    expect(f.updateEnrollment).not.toHaveBeenCalled()
  })
  it('withholds runtime profile Save without source and root read grants',async()=>{
    const f=await fixture(principal(actions.filter(action=>action!=='sources:read'&&action!=='source_roots:read')))
    const listed=runtimeNames((await f.client.listTools()).tools.map(tool=>tool.name))
    expect(listed).not.toContain('job_runtime_profile_save')
    expect(listed).toContain('job_runtime_qualification_request')
  })
  it('denies computer preparation without definition read authority through MCP', async () => {
    const f = await fixture(principal(actions.filter(action => action !== 'job_definitions:read')))
    const listed = (await f.client.listTools()).tools.map(tool => tool.name)
    expect(listed).not.toContain('build_computer_prepare')
    const capabilities = await f.capabilities('workspace-a')
    expect(capabilities.tools).not.toContain('build_computer_prepare')
    expect(capabilities.requirements!.map(requirement => requirement.name)).not.toContain('build_computer_prepare')

    const denied = await unavailableJobRuntimeToolCall(f.context, call('build_computer_prepare'))
    expect(denied?.result.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
    expect(f.recordDenied).toHaveBeenCalledWith(
      'job-discovery', 'mcp', 'build_computer_prepare', 'mcp:build_computer_prepare',
    )
    expect(f.listProfiles).not.toHaveBeenCalled()
    expect(f.choices).not.toHaveBeenCalled()
  })
  it.each(['coder','orchestrator'] as const)('keeps %s workflow Agents outside Job-start authority',async role=>{
    const f=await fixture(),worker={...principal(),audience:'worker' as const,agentId:'agent-fixture'}
    const server=await createGraphqlMcpServer({role,principal:worker,operator:f.context.services})
    const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client=new Client({name:`job-discovery-${role}`,version:'1'})
    connections.push({client,close:()=>server.close()});await client.connect(clientTransport)
    expect(jobNames((await client.listTools()).tools.map(tool=>tool.name))).toEqual([])
    const denied=await roleDeniedToolCall({role,principal:worker,operator:f.context.services},call('job_start'))
    expect(denied?.result.isError).toBe(true);expect(JSON.stringify(denied)).toContain('ROLE_NOT_ALLOWED')
    expect(f.choices).not.toHaveBeenCalled()
  })
})
