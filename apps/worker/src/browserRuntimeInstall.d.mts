export interface BrowserRuntimeDirectory {
  directory: string
  aliasDirectory: string | null
  temporaryDirectory: string
}
export function createBrowserRuntimeDirectory(storageParent: string): Promise<BrowserRuntimeDirectory | null>
export function removeBrowserRuntimeDirectory(runtime: BrowserRuntimeDirectory | null | undefined): Promise<void>
