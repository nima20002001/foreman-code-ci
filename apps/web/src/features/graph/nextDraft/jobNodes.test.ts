import { describe,expect,it } from 'vitest'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import { currentWorkflowFixture } from '../../../shared/mocks/currentWorkflow'
import { definition } from '../../jobs/fixtures'
import { attachAgent,attachJob,draftOperations } from './model'
import { LocalWorkflowFormSchema } from './localGraph'
import { workflowToGraph } from '../mapper'
import { createGraphTopologyProjector } from '../topology'

describe('shared explicit job authoring on the current Board',()=>{
  it('attaches the immutable job version without creating an Agent or provider identity',()=>{
    const f=currentWorkflowFixture('job-board'),saved={...definition,workspaceId:f.scope.workspaceId}
    const graph=attachJob(f.version.definition,saved,'actual-job-node')
    const job=graph.nodes.find(node=>node.id==='actual-job-node')!
    expect(JobWorkflowNodeSchema.parse(job)).toMatchObject({kind:'job',jobDefinitionId:saved.id,jobDefinitionVersionId:saved.versionId,jobDefinitionRevision:saved.revision})
    expect(job).not.toHaveProperty('agentId')
    const context={draft:{id:'draft-job',workspaceId:f.scope.workspaceId,workflowId:f.scope.workflowId,revision:1,publishedRevision:1,stagedAgents:[],graph:f.version.definition,baseWorkflowVersionId:f.version.id,updatedAt:f.createdAt,updatedByPrincipalId:'fixture'},agents:[]}
    const operations=draftOperations(context,graph)
    expect(operations.filter(operation=>operation.type.startsWith('agent.'))).toEqual([])
    expect(operations).toContainEqual({type:'node.replace_v3',node:job})
    const projected=workflowToGraph({workflow:graph,agents:[]}).nodes.find(node=>node.id===job.id)!
    expect(projected.type).toBe('job');expect(projected.data).not.toHaveProperty('agentId');expect(projected.data).not.toHaveProperty('agent')
    const project=createGraphTopologyProjector(),first=project(graph,[]),second=project(graph,[])
    expect(second.nodes).toBe(first.nodes)
  })
  it('keeps unfinished local choices, while accepted job choices require observed outcomes',()=>{
    const f=currentWorkflowFixture('job-partial'),graph=attachJob(f.version.definition,{...definition,workspaceId:f.scope.workspaceId},'job-node')
    const job=graph.nodes.find(node=>node.kind==='job')!
    const partial={...job,choice:{outcomes:[{outcome:'',target:{kind:'edge',relationshipId:''}}]}}
    expect(LocalWorkflowFormSchema.safeParse({...graph,nodes:[...graph.nodes.filter(node=>node.id!==job.id),partial]}).success).toBe(true)
    expect(JobWorkflowNodeSchema.safeParse(partial).success).toBe(false)
    expect(()=>attachJob({...graph,handoffs:{contractVersion:1}},{...definition,workspaceId:graph.workspaceId},'other-job')).toThrow(/DAG/)
  })
  it('allows the same saved Agent at multiple distinct node identities',()=>{
    const f=currentWorkflowFixture('same-agent'),configuration=f.configurations[0]!
    const record={agent:{id:configuration.agentId,name:'Shared worker',productRole:'coder' as const,configurationVersionId:configuration.id},metadataRevision:1,archivedAt:null}
    const graph=attachAgent(f.version.definition,record,'second-instance-of-agent')
    expect(graph.nodes.filter(node=>node.kind!=='job'&&node.agentId===configuration.agentId)).toHaveLength(2)
    expect(()=>attachAgent(graph,record,'second-instance-of-agent')).toThrow(/node identity/)
  })
})
