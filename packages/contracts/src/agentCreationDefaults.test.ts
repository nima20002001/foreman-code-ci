import { describe, expect, it } from 'vitest'
import { AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, agentTemplateForRole } from './index.js'
import { effectiveGraphqlTools, graphqlRoleTools, newAgentGraphqlTools } from './graphqlMcpTools.js'
import { memoryBoardTools } from './collaborationTools.js'

describe('new Agent memory defaults and preserved saved choices', () => {
  it.each(['master', 'orchestrator', 'coder'] as const)('copies the %s memory default only on explicit creation', role => {
    const access = role === 'coder' ? 'read' : 'write'
    expect(newAgentGraphqlTools(role)).toEqual([...graphqlRoleTools(role), ...memoryBoardTools(access)])
    expect(effectiveGraphqlTools(role, undefined, undefined, false, memoryBoardTools('write')))
      .not.toEqual(expect.arrayContaining(memoryBoardTools('read')))
    expect(effectiveGraphqlTools(role, newAgentGraphqlTools(role))).toEqual(graphqlRoleTools(role))
    expect(effectiveGraphqlTools(role, newAgentGraphqlTools(role), undefined, false, memoryBoardTools('write')))
      .toEqual(expect.arrayContaining(memoryBoardTools(access)))
    expect(effectiveGraphqlTools(role, [], undefined, false, memoryBoardTools('write'))).toEqual(['bug_report'])
  })

  it('preserves old defaults byte-for-byte and uses explicit Master templates before the old Orchestrator fallback', () => {
    const old = structuredClone(DEFAULT_AGENT_DEFAULTS)
    expect(agentTemplateForRole(old, 'master')).toEqual({ ...old.orchestrator, role: 'master' })
    expect(old).toEqual(DEFAULT_AGENT_DEFAULTS)
    expect(old.master).toBeUndefined()
    const updated = AgentDefaultsSchema.parse({ ...old,
      master: { ...old.orchestrator, role: 'master', graphqlTools: [] },
      coder: { ...old.coder, graphqlTools: memoryBoardTools('write') },
    })
    expect(agentTemplateForRole(updated, 'master').graphqlTools).toEqual([])
    expect(agentTemplateForRole(updated, 'coder').graphqlTools).toEqual(memoryBoardTools('write'))
    expect(AgentDefaultsSchema.safeParse({ ...old,
      operator: { ...old.operator, graphqlTools: memoryBoardTools('read') } }).success).toBe(false)
  })
})
