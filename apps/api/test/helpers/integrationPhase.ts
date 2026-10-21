import { expect } from 'vitest'
import { integrationPhaseLine } from '../../../../scripts/integration-phase.mjs'

export function reportIntegrationPhase(phase: string, elapsedMs: number): void {
  const file = process.env.FOREMAN_CODE_TEST_FILE ?? expect.getState().testPath ?? 'integration'
  console.info(integrationPhaseLine(file, phase, elapsedMs))
}

export async function measureIntegrationPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await operation()
  } finally {
    reportIntegrationPhase(phase, performance.now() - started)
  }
}
