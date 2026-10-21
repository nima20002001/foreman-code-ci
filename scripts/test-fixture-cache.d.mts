export function testFixtureCacheRoot(environment?: Record<string, string | undefined>): string
export function workerFixtureInputs(repository: string, commit: string): Promise<Buffer>
export function cachedTestFixture(
  root: string,
  namespace: string,
  inputs: readonly (string | Buffer)[],
  populate: (directory: string) => Promise<void>,
): Promise<string>
export function cachedWorkerRelease(
  root: string,
  repository: string,
  commit: string,
  identityParts: readonly (string | Buffer)[],
  build: (directory: string) => Promise<void>,
  options?: { onCacheStatus?: (status: {
    status: 'hit' | 'miss' | 'invalid'; lastError: string | null
    missCount: number; rebuildCount: number
  }) => void },
): Promise<string>

export function withTestFixtureCacheLock<T>(root: string, namespace: string, work: () => Promise<T>): Promise<T>
