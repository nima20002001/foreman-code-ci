import { availableParallelism, totalmem } from 'node:os'
import type { CiPreparationLimits } from '@foreman-code/contracts'

export function ciPreparationLimits(): CiPreparationLimits {
  return { cpuCount: availableParallelism() / 2, memoryBytes: Math.floor(totalmem() / 2) }
}

export function ciPreparationBuildArgs(limits: CiPreparationLimits): string[] {
  return ['--jobs=1', ...ciPreparationResourceArgs(limits)]
}

export function ciPreparationResourceArgs(limits: CiPreparationLimits): string[] {
  return ['--cpu-period=100000', `--cpu-quota=${Math.floor(limits.cpuCount * 100000)}`,
    `--memory=${limits.memoryBytes}`, `--memory-swap=${limits.memoryBytes}`]
}
