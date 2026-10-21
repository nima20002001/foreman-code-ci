export interface IntegrationCoverage {
  version: 1
  commit: string
  testFiles: string[]
  coverage: Record<string, string[]>
  staticTests?: string[]
}
export function isIntegrationCoverage(value: unknown): value is IntegrationCoverage
export function completeIntegrationCoverage(value: unknown): value is IntegrationCoverage
export function usableIntegrationCoverage(value: unknown): value is IntegrationCoverage
export interface CompactIntegrationCoverage extends Omit<IntegrationCoverage, 'coverage'> {
  sourceFiles: string[]
  coverage: Record<string, number[]>
}
export function compactIntegrationCoverage(map: IntegrationCoverage): CompactIntegrationCoverage
export function expandIntegrationCoverage(value: unknown): IntegrationCoverage
