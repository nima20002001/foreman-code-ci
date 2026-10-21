import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { integrationGate, scheduleIntegrationQueue } from '../../../../../scripts/test-integration.mjs'
import { fixture } from './cloud.testSupport.js'

interface Workflow {
  parameters?: Record<string, { default: unknown }>
  on?: { workflow_dispatch: { inputs: Record<string, { default: unknown }> } }
  jobs: { ci: { env?: Record<string, string>; environment?: Record<string, string> } }
}

it.each(['github', 'circleci'] as const)('preserves gate retest behavior through %s dispatch and workflow environment',
  async provider => {
    const f = await fixture({}, { provider })
    const path = provider === 'github' ? '.github/workflows/ci.yml' : '.circleci/config.yml'
    const workflow = parse(await readFile(new URL(`../../../../../${path}`, import.meta.url), 'utf8')) as Workflow
    const declarations = provider === 'github' ? workflow.on!.workflow_dispatch.inputs : workflow.parameters!
    const environment = workflow.jobs.ci.env ?? workflow.jobs.ci.environment!
    const file = 'apps/api/test/a.integration.test.ts'
    for (const gate of [true, false]) {
      await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
        repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full',
        ...(gate ? { gate: true, files: [file], integrationShards: 4 } : {}) })
      const args = provider === 'github' ? f.dispatched.at(-1)! : f.circle.triggered.at(-1)!
      const parameters: Record<string, unknown> = Object.fromEntries(Object.entries(declarations)
        .map(([name, declaration]) => [name, declaration.default ?? '']))
      const argument = provider === 'github' ? '-f' : '--parameter'
      for (let index = 0; index < args.length; index++) {
        if (args[index] !== argument) continue
        const value = args[index + 1]!
        const separator = value.indexOf('=')
        const name = value.slice(0, separator)
        expect(declarations[name], `Declared ${provider} parameter ${name}`).toBeDefined()
        parameters[name] = value.slice(separator + 1)
      }
      const resolved = Object.fromEntries(Object.entries(environment).map(([name, value]) => [name,
        String(value).replace(/\$\{\{\s*inputs\.(\w+)\s*\}\}|<<\s*pipeline.parameters\.(\w+)\s*>>/g,
          (_match, github: string | undefined, circle: string | undefined) => String(parameters[github ?? circle!])),
      ]))
      const runFile = vi.fn(async () => ({ code: 1, complete: true }))
      const prepareRetest = vi.fn(async () => undefined)
      const result = await scheduleIntegrationQueue([file], [{ index: 1 }], {
        gate: integrationGate(resolved), maxConcurrency: 1, pollIntervalMs: 1,
        samplePressure: () => ({ cpuUtilization: 0, cpuPressure: 0, memoryPressure: 0,
          memoryUtilization: 0, totalMemoryBytes: 16 * 2 ** 30, cpuCount: 4 }),
        runFile, prepareRetest,
      })
      expect(result.results[0]!.status).toBe('FAILED')
      expect(runFile).toHaveBeenCalledTimes(gate ? 1 : 2)
      expect(prepareRetest).toHaveBeenCalledTimes(gate ? 0 : 1)
    }
  })
