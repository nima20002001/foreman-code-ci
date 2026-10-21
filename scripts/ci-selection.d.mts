export function executionFiles(files: readonly string[], executionSuite: string, cwd: string): string[]
export function executionDurations(suite: string, cwd: string, learned?: Record<string, number>): Record<string, number>
export function executionSelection(input: {
  commit: string; baseCommit?: string; executionSuite: string; defaultRef?: string
  partition?: { index: number; count: number; weights?: number[] }; learned?: Record<string, number>; cwd?: string
}): { scope: 'full' | 'affected'; files: string[]; reason?: string }
