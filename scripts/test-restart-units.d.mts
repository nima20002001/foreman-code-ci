import type { TestRoot } from './test-resources.mjs'

export function removeRestartUnit(unit: string): Promise<void>
export function sweepRestartUnits(resource: TestRoot, directory?: string): Promise<void>
