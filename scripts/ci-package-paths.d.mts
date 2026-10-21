export interface CiPackagePaths { storeDir: string; cacheDir: string }
export function writeCiPackagePaths(root: string, paths: CiPackagePaths): void
export function readCiPackagePaths(root: string, environment?: NodeJS.ProcessEnv): CiPackagePaths
