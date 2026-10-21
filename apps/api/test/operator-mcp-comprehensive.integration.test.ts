import { removeFixtureDirectory } from './helpers/testResources.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { OperatorLifecycleService } from '../src/modules/workspaces/operatorLifecycle.js'
import { SkillCatalogService } from '../src/modules/skills/catalog.js'
import { VersionHistoryService } from '../src/modules/workflows/historyManagement.js'

describe.skipIf(!postgresEnabled)('Operator domain-service persistence on isolated PostgreSQL schema',()=>{
  let database: Awaited<ReturnType<typeof currentDatabase>>
  const directories:string[]=[]
  beforeAll(async()=>{ database = await currentDatabase() }, 60000)
  afterAll(async()=>{
    await database?.close()
    for(const directory of directories) await removeFixtureDirectory(directory)
  })
  it('persists skills, reuses Agents, and preserves exact V3 Save receipts and immutable history',async()=>{
    const runtime=await mkdtemp(join(tmpdir(),'mcp-runtime-'));directories.push(runtime)
    const project=await mkdtemp(join(tmpdir(),'mcp-project-'));directories.push(project)
    const commands=new PostgresCommandCoordinator(database.pool)
    const access=new PostgresAccessService(database.pool)
    const {principal}=await access.issue({name:'MCP bundle fixture',audience:'operator',grants:[{actions:[...ManagementActionSchema.options],scope:{}}],expiresAt:new Date(Date.now()+600_000)})
    const locations=new WorkspaceLocationService(database.pool,commands,runtime)
    const workspaces=new WorkspaceManagementService(database.pool,commands,locations)
    const workspace=(await workspaces.create(principal,'mcp',{commandId:'fixture-workspace',name:'Comprehensive fixture'})).value.workspace
    await locations.set(principal,'mcp',{workspaceId:workspace.id,commandId:'fixture-location',expectedLocationRevision:0,runnerId:'runner-local',rootPath:project})
    const skills=new SkillCatalogService(database.pool,commands)
    const skill=(await skills.create(principal,{workspaceId:workspace.id,commandId:'fixture-skill',name:'Test guide',instructions:'Use deterministic checks.'},'mcp')).value.skill
    await expect(skills.create(principal,{workspaceId:workspace.id,commandId:'fixture-skill',name:'Overwrite attempt',instructions:'Different content.'},'mcp')).rejects.toMatchObject({code:'COMMAND_ID_CONFLICT'})
    const agents=new OperatorAgentMutationService(database.pool,commands,{qualifyConfiguration:async value=>({harness:value.harness,version:'fixture',authenticated:true,ready:true,structuredEvents:true,supportsResume:true,supportsCancellation:true,supportsWorkingDirectory:true,supportsStartupPrompt:true,supportedNativeTools:[],supportedSettings:[],unsupportedCapabilities:[]})})
    const agent=(await agents.create(principal,{workspaceId:workspace.id,agentId:'fixture-agent',commandId:'fixture-agent-create',name:'Worker',productRole:'coder',configuration:{harness:'codex',model:'fixture',reasoningEffort:'low',sandbox:'read-only',serviceTier:'standard'},assignedSkills:[{skillId:skill.skillId,version:skill.version}]})).value
    const history=new VersionHistoryService(database.pool)
    const savedConfiguration=(await history.agent(principal,{workspaceId:workspace.id,agentId:agent.agent.id,versionId:agent.agent.configurationVersionId!})).version
    expect(savedConfiguration.resolvedSkills?.[0]?.instructions).toBe('Use deterministic checks.')
    const workflows=new WorkflowManagementService(database.pool,commands)
    const managed=(await workflows.create(principal,'mcp',{workspaceId:workspace.id,commandId:'fixture-workflow',name:'Current fixture'})).value
    const workflow=managed.workflow
    const input={workspaceId:workspace.id,workflowId:workflow.id,commandId:'fixture-save',executionSemanticsVersion:3,
      expectedRevision:managed.revision,expectedWorkflowVersionId:null,
      expectedAgentConfigurationVersionIds:{[agent.agent.id]:agent.agent.configurationVersionId!},
      graph:{...workflow,entryNodeId:'node',nodes:[{id:'node',agentId:agent.agent.id,name:'Worker'}],edges:[],
        approval:{handler:'user'},executionCondition:{kind:'manual'},executionPolicy:{maxParallelism:1,maxNodeExecutions:1}}}
    const published=await workflows.current.save(principal,'mcp',input)
    expect((await history.workflows(principal,{workspaceId:workspace.id,workflowId:workflow.id,limit:10})).items).toHaveLength(1)
    expect(await workflows.current.save(principal,'mcp',input)).toEqual({...published,replayed:true})
    await expect(workflows.current.save(principal,'mcp',{...input,graph:{...input.graph,name:'Changed command'}}))
      .rejects.toMatchObject({code:'COMMAND_ID_CONFLICT'})
    const next=await workflows.current.save(principal,'mcp',{...input,commandId:'fixture-next-save',
      expectedRevision:published.value.revision,expectedWorkflowVersionId:published.value.currentVersionId,
      graph:{...published.value.version.definition,name:'Next saved workflow'}})
    expect(next.value.currentVersionId).not.toBe(published.value.currentVersionId)
    const pinned=await workflows.current.read(principal,{workspaceId:workspace.id,workflowId:workflow.id,
      workflowVersionId:published.value.currentVersionId})
    expect(pinned.version).toEqual(published.value.version)
    expect(pinned.currentVersionId).toBe(next.value.currentVersionId)
    expect((await database.pool.query('select id from runs where workflow_id=$1',[workflow.id])).rows).toHaveLength(0)
  },30_000)

  it('archives and restores an unused Agent without deleting configuration history',async()=>{
    const commands=new PostgresCommandCoordinator(database.pool)
    const access=new PostgresAccessService(database.pool)
    const {principal}=await access.issue({name:'Lifecycle fixture',audience:'operator',grants:[{actions:[...ManagementActionSchema.options],scope:{}}],expiresAt:new Date(Date.now()+600_000)})
    const locations=new WorkspaceLocationService(database.pool,commands)
    const workspace=(await new WorkspaceManagementService(database.pool,commands,locations).create(principal,'mcp',{commandId:'lifecycle-workspace',name:'Lifecycle fixture'})).value.workspace
    const agents=new OperatorAgentMutationService(database.pool,commands,{qualifyConfiguration:async value=>({harness:value.harness,version:'fixture',authenticated:true,ready:true,structuredEvents:true,supportsResume:true,supportsCancellation:true,supportsWorkingDirectory:true,supportsStartupPrompt:true,supportedNativeTools:[],supportedSettings:[],unsupportedCapabilities:[]})})
    const agent=(await agents.create(principal,{workspaceId:workspace.id,agentId:'unused-agent',commandId:'unused-agent-create',name:'Unused',productRole:'coder',configuration:{harness:'codex',model:'fixture',reasoningEffort:'low',sandbox:'read-only',serviceTier:'standard'}})).value
    const lifecycle=new OperatorLifecycleService(commands)
    const archived=await lifecycle.agent(principal,{workspaceId:workspace.id,agentId:agent.agent.id,expectedRevision:agent.metadataRevision,commandId:'unused-archive'},true)
    expect(archived.value.archived).toBe(true)
    const restored=await lifecycle.agent(principal,{workspaceId:workspace.id,agentId:agent.agent.id,expectedRevision:archived.value.revision,commandId:'unused-restore'},false)
    expect(restored.value.archived).toBe(false)
    const versions=await database.pool.query('select id from agent_configuration_versions where agent_id=$1',[agent.agent.id])
    expect(versions.rows).toHaveLength(1)
  })
})
