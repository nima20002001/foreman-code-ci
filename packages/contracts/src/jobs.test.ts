import { describe, expect, it } from 'vitest'
import { JobAuthoringChoicesSchema, JobDefinitionSpecSchema, JobTargetSchema } from './jobs.js'
import { makeCurrentWorkflowFixture } from './wave25/currentFixture.js'
import { JobWorkflowNodeSchema } from './jobWorkflow.js'
import { GraphExecutionIdentitySchema, ExecutableWorkflowV3Schema } from './wave25/index.js'

describe('job contracts and same-Agent workflow nodes',()=>{
  it('admits an explicit job node and job identity without Agent or native-provider fields',()=>{
    const fixture=makeCurrentWorkflowFixture('ci-job-only')
    const node=JobWorkflowNodeSchema.parse({kind:'job',id:'job-node',name:'Build',jobDefinitionId:'job-definition',jobDefinitionRevision:1,jobDefinitionVersionId:'job-version'})
    const version={...fixture.version,entryNodeId:node.id,agentConfigurationVersionIds:{},definition:{...fixture.version.definition,entryNodeId:node.id,nodes:[node],edges:[],approval:{handler:'user'}}}
    expect(ExecutableWorkflowV3Schema.safeParse({version,configurations:[]}).success).toBe(true)
    expect(GraphExecutionIdentitySchema.safeParse({kind:'job',workflowNodeId:node.id,executionId:'real-job',jobDefinitionId:'job-definition',jobDefinitionVersionId:'job-version',attempt:1}).success).toBe(true)
    expect(JobWorkflowNodeSchema.safeParse({...node,agentId:'fabricated'}).success).toBe(false)
  })
  it('loads target schema at runtime and does not fabricate Agent or Run identity',()=>{
    const shape=JobTargetSchema.shape
    expect(Object.keys(shape)).not.toContain('agentId')
    expect(Object.keys(shape)).not.toContain('runId')
    expect(JobAuthoringChoicesSchema.parse({targets:[],sources:[],policies:[]})).toEqual({targets:[],sources:[],policies:[]})
    expect(JobDefinitionSpecSchema.safeParse({argv:['echo','ok']}).success).toBe(false)
  })
  it('accepts separate nodes sharing exactly one immutable Agent configuration',()=>{
    const fixture=makeCurrentWorkflowFixture('ci-same-agent')
    const node=fixture.version.definition.nodes[0]!
    fixture.version.definition.nodes.push({...node,id:`${node.id}-second`,name:'Second placement'})
    fixture.version.definition.edges.push({id:'same-agent-next',source:node.id,target:`${node.id}-second`,kind:'execution'})
    fixture.version.definition.executionPolicy!.maxNodeExecutions++
    if(fixture.version.definition.requiredAgentCount!==undefined) fixture.version.definition.requiredAgentCount=1
    expect(ExecutableWorkflowV3Schema.safeParse({version:fixture.version,configurations:fixture.configurations}).success).toBe(true)
    fixture.version.definition.nodes[1]!.id=node.id
    expect(ExecutableWorkflowV3Schema.safeParse({version:fixture.version,configurations:fixture.configurations}).success).toBe(false)
  })
})
