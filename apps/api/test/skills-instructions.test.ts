import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AgentConfigurationVersion, HarnessExecutionRequest, ResolvedSkill } from '@foreman-code/contracts'
import { agentInstructionBundle } from '../src/modules/skills/instructions.js'
import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'

const hash = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
const skill = (skillId: string, version: string, instructions: string, name?: string): ResolvedSkill =>
  ({ skillId, version, instructions, contentHash: hash(instructions), ...(name ? { name } : {}) })
function configuration(patch: Partial<AgentConfigurationVersion> = {}): AgentConfigurationVersion {
  return { id: 'config-1', workspaceId: 'workspace-1', agentId: 'agent-1', version: 1, prompt: { system: 'Persistent rules.' },
    assignedSkills: [], instructionDelivery: 'native-v1', contentHash: 'sha256:test', createdAt: '2026-09-27T00:00:00.000Z',
    harness: { harness: 'codex', model: 'fixture', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' }, ...patch }
}
function request(config: AgentConfigurationVersion): HarnessExecutionRequest {
  return { executionId: 'execution-1', runId: 'run-1', workspaceId: 'workspace-1', workflowNodeId: 'node-1',
    workingDirectory: '/w', runtimeDirectory: '/w', input: { task: 'do it' }, initialPrompt: 'Initial task', configuration: config }
}

describe('Agent instruction composition', () => {
  it('puts persistent instructions first, then every full skill body in saved order', () => {
    const skills = [skill('skill-b', '3', '  B body\n\nwith spacing  ', 'Beta'), skill('skill-a', '1', 'A body ✓')]
    const bundle = agentInstructionBundle(configuration({ assignedSkills: skills.map(({ skillId, version }) => ({ skillId, version })), resolvedSkills: skills }))!
    expect(bundle.text).toBe('Persistent rules.\n\n# Skill: Beta (skill-b@3)\n\n  B body\n\nwith spacing  \n\n# Skill: skill-a (skill-a@1)\n\nA body ✓')
    expect(bundle).toMatchObject({ delivery: 'native-v1', hash: hash(bundle.text) })
  })

  it('delivers nothing extra for Agents without instructions or skills', () => {
    expect(agentInstructionBundle(configuration({ prompt: {} }))).toBeUndefined()
    expect(agentInstructionBundle(configuration())?.text).toBe('Persistent rules.')
  })

  it('keeps configurations accepted before native delivery on their original in-task path', () => {
    const skills = [skill('skill-a', '1', 'Legacy skill body')]
    const legacy = configuration({ instructionDelivery: undefined, assignedSkills: [{ skillId: 'skill-a', version: '1' }], resolvedSkills: skills })
    delete legacy.instructionDelivery
    expect(agentInstructionBundle(legacy)).toBeUndefined()
    const prompt = buildHarnessPrompt(request(legacy))
    expect(prompt).toContain('PRODUCT AGENT SYSTEM PROMPT\nPersistent rules.')
    expect(prompt).toContain('ASSIGNED SKILL skill-a@1\nLegacy skill body')
  })

  it('keeps task input separate: native-v1 task text never repeats instructions or skill bodies', () => {
    const skills = [skill('skill-a', '1', 'Unique skill sentinel')]
    const prompt = buildHarnessPrompt(request(configuration({ assignedSkills: [{ skillId: 'skill-a', version: '1' }], resolvedSkills: skills })))
    expect(prompt).not.toContain('Persistent rules.')
    expect(prompt).not.toContain('Unique skill sentinel')
    expect(prompt).not.toContain('ASSIGNED SKILL')
    expect(prompt).toContain('INITIAL USER PROMPT\nInitial task')
    expect(prompt).toContain('{"task":"do it"}')
  })

  it('fails visibly on missing, reordered, or corrupt snapshots instead of dropping them', () => {
    const good = skill('skill-a', '1', 'Body')
    const reference = [{ skillId: 'skill-a', version: '1' }]
    const other = skill('skill-b', '1', 'Different instructions')
    expect(() => agentInstructionBundle(configuration({
      assignedSkills: [...reference, { skillId: 'skill-b', version: '1' }],
      resolvedSkills: [other, good],
    }))).toThrow(/integrity/)
    expect(() => agentInstructionBundle(configuration({ assignedSkills: reference }))).toThrow(/Republish/)
    expect(() => agentInstructionBundle(configuration({ assignedSkills: reference, resolvedSkills: [{ ...good, instructions: 'Tampered' }] }))).toThrow(/integrity/)
    expect(() => agentInstructionBundle(configuration({ assignedSkills: [{ skillId: 'skill-a', version: '2' }], resolvedSkills: [good] }))).toThrow(/integrity/)
    expect(() => agentInstructionBundle(configuration({ assignedSkills: [...reference, { skillId: 'skill-b', version: '1' }], resolvedSkills: [good] }))).toThrow(/Republish/)
  })

  it('rejects oversized instruction bundles without truncating them', () => {
    const skills = Array.from({ length: 6 }, (_, index) => skill(`skill-${index}`, '1', 'x'.repeat(100_000)))
    const config = configuration({ assignedSkills: skills.map(({ skillId, version }) => ({ skillId, version })), resolvedSkills: skills })
    expect(() => agentInstructionBundle(config)).toThrow(/exceed 512 KiB/)
  })

  it('composes application-level Operator skills with the same rule, without persistent Agent instructions', () => {
    const skills = [skill('skill-a', '4', 'Operator guidance', 'Guide')]
    const bundle = agentInstructionBundle({ assignedSkills: [{ workspaceId: 'workspace-2', skillId: 'skill-a', version: '4' }], resolvedSkills: skills, instructionDelivery: 'native-v1' })
    expect(bundle?.text).toBe('# Skill: Guide (skill-a@4)\n\nOperator guidance')
    expect(agentInstructionBundle({ instructionDelivery: 'native-v1' })).toBeUndefined()
  })
  it('verifies workspace-qualified Operator snapshots and rejects cross-workspace swaps', () => {
    const references = ['workspace-a', 'workspace-b'].map((workspaceId) => ({ workspaceId, skillId: 'shared', version: '1' }))
    const snapshots = references.map((reference) => ({ ...skill('shared', '1', 'Same body'), workspaceId: reference.workspaceId }))
    const source = { assignedSkills: references, resolvedSkills: snapshots, instructionDelivery: 'native-v1' as const }
    expect(agentInstructionBundle(source)?.text.match(/Same body/g)).toHaveLength(2)
    expect(() => agentInstructionBundle({ ...source, assignedSkills: [references[0]!, references[0]!] })).toThrow(/Republish/)
    expect(() => agentInstructionBundle({ ...source, resolvedSkills: [...snapshots].reverse() })).toThrow(/integrity/)
  })

})
