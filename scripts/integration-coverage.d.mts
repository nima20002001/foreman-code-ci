export function startFileCoverage(): Promise<{
  (root: string, tracked: Set<string>): Promise<string[]>
  requiresStatic?: boolean
}>
export function writeFileCoverage(directory: string, file: string, files: string[], requiresStatic?: boolean): void
