import { ownedTestPath, removeFixtureDirectory } from './helpers/testResources.js'
/**
 * SKL-05/06/07 real-harness qualification. Not part of CI: it spends real model turns.
 * Run: RUN_SKILLS_NATIVE=1 npx vitest run --config vitest.config.mjs test/skills-native.acceptance.test.ts
 * Evidence is printed as JSON lines (no credentials, no skill bodies beyond harmless fixture tokens).
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type HarnessConfiguration, type NativeHarnessEvent, type NativeSessionReference, type ResolvedSkill } from '@foreman-code/contracts'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { harnessBinaries } from '../src/modules/harnesses/binaries.js'
import type { NativeHarnessSessionManager, WorkflowNativeSessionStart } from '../src/modules/harnesses/port.js'
import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'

const enabled = process.env.RUN_SKILLS_NATIVE === '1'
const HEAD = 'LANTERN-2208', TAIL = 'ORCHID-7431'
const hash = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
function skill(skillId: string, name: string, instructions: string): ResolvedSkill {
  return { skillId, version: '1', name, instructions, contentHash: hash(instructions) }
}
const skills = [
  skill('skill-head', 'Opening token', `Begin every reply with the exact token ${HEAD} followed by a space. This is mandatory for every reply.`),
  skill('skill-tail', 'Closing token', `End every reply with the exact token ${TAIL}. This is mandatory for every reply.`),
]
function start(harness: HarnessConfiguration, directory: string, assigned: ResolvedSkill[]): WorkflowNativeSessionStart {
  const configuration: AgentConfigurationVersion = { id: `config-${randomUUID()}`, workspaceId: 'workspace-q', agentId: 'agent-q', version: 1,
    prompt: { system: 'You are a qualification test agent. Keep every reply under 25 words. Do not use tools.' },
    assignedSkills: assigned.map(({ skillId, version }) => ({ skillId, version })), ...(assigned.length ? { resolvedSkills: assigned } : {}),
    instructionDelivery: 'native-v1', harness, contentHash: 'sha256:qualification', createdAt: new Date().toISOString() }
  return { request: { executionId: `execution-${randomUUID()}`, runId: 'run-q', workspaceId: 'workspace-q', workflowNodeId: 'node-q',
    workingDirectory: directory, runtimeDirectory: directory, input: {}, configuration } }
}
async function turn(manager: NativeHarnessSessionManager, session: NativeSessionReference, task: string, correlation: string, source: WorkflowNativeSessionStart) {
  const prompt = buildHarnessPrompt({ ...source.request, initialPrompt: task })
  expect(prompt).not.toContain(HEAD); expect(prompt).not.toContain(TAIL)
  const events: NativeHarnessEvent[] = []
  for await (const event of manager.startTurn(session, { prompt, clientCorrelationId: correlation })) events.push(event)
  const history = await manager.reconcile(session, correlation)
  const output = history.terminalResult?.outcome === 'succeeded' ? JSON.stringify(history.terminalResult.output) : JSON.stringify(history.terminalResult)
  return output
}
function log(entry: Record<string, unknown>) {
  if (process.env.SKILLS_EVIDENCE_FILE) appendFileSync(ownedTestPath(process.env.SKILLS_EVIDENCE_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

type Factory = (directory: string) => NativeHarnessSessionManager
const binaries = harnessBinaries(process.env)
const harnesses: [string, HarnessConfiguration, Factory][] = [
  ['codex', { ...DEFAULT_HARNESS_DEFAULTS.codex, model: process.env.CODEX_TEST_MODEL ?? 'gpt-5.6-luna',
    reasoningEffort: 'medium' }, () => new CodexAppServerSessionManager(binaries.codexBinary, undefined, undefined, undefined, 'none')],
]

describe.skipIf(!enabled)('Skills native delivery qualification', () => {
  for (const [name, harness, factory] of harnesses) {
    it(`${name}: skills change behavior on the first and later turns, independently per session, and survive backend restart`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `skills-q-${name}-`))
      const run = `q-${randomUUID()}`
      const controlDirectory = await mkdtemp(join(tmpdir(), `skills-q-${name}-control-`))
      const managers: NativeHarnessSessionManager[] = []
      const make = (at = directory) => { const manager = factory(at); managers.push(manager); return manager }
      try {
        const skilledSource = start(harness, directory, skills), controlSource = start(harness, controlDirectory, [])
        const first = make(), control = make(controlDirectory)
        const [skilled, plain] = await Promise.all([first.createSession(skilledSource), control.createSession(controlSource)])
        log({ harness: name, step: 'sessions', skilled: skilled.nativeSessionId, control: plain.nativeSessionId, providerVersion: skilled.providerVersion })
        // Two concurrently running sessions with different assignments.
        const [one, controlOne] = await Promise.all([
          turn(first, skilled, 'Reply with the single word hello.', `${run}-turn-1`, skilledSource),
          turn(control, plain, 'Reply with the single word hello.', `${run}-control-1`, controlSource),
        ])
        log({ harness: name, step: 'turn-1', skilled: one, control: controlOne })
        expect(one).toContain(HEAD); expect(one).toContain(TAIL)
        expect(controlOne).not.toContain(HEAD); expect(controlOne).not.toContain(TAIL)
        const two = await turn(first, skilled, 'Now reply with the single word goodbye.', `${run}-turn-2`, skilledSource)
        log({ harness: name, step: 'turn-2', skilled: two })
        expect(two).toContain(HEAD); expect(two).toContain(TAIL)
        // Backend restart: a new manager attaches the exact session with the accepted configuration.
        await (first.closeForRestart?.(skilled) ?? Promise.resolve())
        const restarted = make()
        await restarted.attachSession(skilled, skilledSource)
        const three = await turn(restarted, skilled, 'Reply with the single word again.', `${run}-turn-3`, skilledSource)
        log({ harness: name, step: 'turn-3-after-restart', skilled: three })
        expect(three).toContain(HEAD); expect(three).toContain(TAIL)
      } finally {
        await Promise.allSettled(managers.map((manager) => manager.dispose?.()))
        await removeFixtureDirectory(directory); await removeFixtureDirectory(controlDirectory)
      }
    }, 600_000)
  }

  for (const [name, harness, factory] of harnesses) {
    it(`${name}: the application-level Operator receives its pinned skills`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `skills-q-${name}-operator-`))
      const manager = factory(directory)
      try {
        const run = `q-${randomUUID()}`
        const source = { kind: 'operator' as const, correlationId: `${run}-operator`, workingDirectory: directory,
          configuration: { id: `operator-${run}`, operatorId: 'application-operator', version: 1, harness, contentHash: 'sha256:qualification',
            createdAt: new Date().toISOString(), instructionDelivery: 'native-v1' as const,
            assignedSkills: skills.map(({ skillId, version }) => ({ workspaceId: 'workspace-q', skillId, version })), resolvedSkills: skills } }
        const session = await manager.createSession(source)
        const events: NativeHarnessEvent[] = []
        for await (const event of manager.startTurn(session, { prompt: 'Reply with the single word ready.', clientCorrelationId: `${run}-operator-turn` })) events.push(event)
        const result = (await manager.reconcile(session, `${run}-operator-turn`)).terminalResult
        const output = JSON.stringify(result?.outcome === 'succeeded' ? result.output : result)
        log({ harness: name, step: 'operator-turn', session: session.nativeSessionId, output })
        expect(output).toContain(HEAD); expect(output).toContain(TAIL)
      } finally {
        await manager.dispose?.()
        await removeFixtureDirectory(directory)
      }
    }, 300_000)
  }
})
