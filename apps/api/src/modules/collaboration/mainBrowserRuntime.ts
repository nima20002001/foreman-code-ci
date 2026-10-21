import { readFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BrowserHostOptions, createBrowserHost } from '../browser-runtime/hostFactory.js'
import type { BrowserRuntimeInstallation } from '../browser-runtime/browserUseAdapter.js'
import { DomainError } from '../errors.js'

type Host = Awaited<ReturnType<typeof createBrowserHost>>
type Descriptor = BrowserRuntimeInstallation & { nativeHostModule: string; manifestSha256: string }
interface Installer {
  readInstalledBrowserRuntime(input: { runtimeRoot: string; target: unknown }): Promise<Descriptor>
  activateBrowserRuntime(input: { runtimeRoot: string; staged: Descriptor; drain: () => Promise<unknown> }): Promise<unknown>
  offlineBrowserRuntimeLifecycle(input: { nativeHostModule: string; profileStateRoot: string }): Promise<{ drain(): Promise<unknown> }>
}

/** Reading status never installs or starts Chromium; only explicit application startup opens its verified host. */
export class MainBrowserRuntime {
  private host: Host | undefined
  private opening: Promise<void> | undefined
  private failure: string | null = 'Browser runtime is not installed.'
  private closed = false
  private runtimeRoot: string | undefined
  private readonly release = fileURLToPath(new URL('../../../../../', import.meta.url))
  constructor(private readonly options: Omit<BrowserHostOptions, 'runtime'> & { runtimeRoot?: string | undefined }) {
    this.runtimeRoot = options.runtimeRoot
  }
  status() { return { computerId: this.options.computerId, ready: this.host?.status().ready ?? false,
    phase: this.closed ? 'stopped' : this.opening ? 'starting' : this.host ? 'ready' : 'unavailable', reason: this.failure } }
  getHost() {
    if (!this.host) throw new DomainError('BROWSER_RUNTIME_UNAVAILABLE', this.failure ?? 'The browser runtime is unavailable.', 503)
    return this.host
  }
  private async installer(): Promise<Installer> {
    return import(pathToFileURL(join(this.release, 'apps/worker/src/browserRuntimeInstall.mjs')).href) as Promise<Installer>
  }
  async start(): Promise<void> {
    if (this.closed || this.host) return
    if (this.opening) return this.opening
    this.opening = this.open().finally(() => { this.opening = undefined })
    return this.opening
  }
  private async open() {
    try {
      await this.options.assertHostOwnership()
      const receiptPath = join(this.release, 'browser-runtime.json')
      const stat = await lstat(receiptPath)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('The browser release descriptor is not private.')
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { runtimeRoot?: string; state?: string; reason?: string; staged?: { manifestSha256?: string } }
      if (receipt.state !== 'ready' || !receipt.runtimeRoot) throw new Error(receipt.reason ?? 'The release has no verified browser runtime.')
      if (this.runtimeRoot && this.runtimeRoot !== receipt.runtimeRoot) throw new Error('The browser release belongs to another runtime root.')
      this.runtimeRoot = receipt.runtimeRoot
      const diagnostics = await import(pathToFileURL(join(this.release, 'apps/worker/src/diagnostics.mjs')).href)
      const facts = await diagnostics.hostFacts(process.env.HOME ?? '', [this.options.stateDirectory])
      const descriptor = await (await this.installer()).readInstalledBrowserRuntime({ runtimeRoot: this.runtimeRoot, target: facts })
      if (!receipt.staged?.manifestSha256 || descriptor.manifestSha256 !== receipt.staged.manifestSha256) {
        throw new Error('The installed browser runtime does not match this release.')
      }
      const native = await import(pathToFileURL(descriptor.nativeHostModule).href) as { createBrowserHost: typeof createBrowserHost }
      await this.options.assertHostOwnership()
      if (this.closed) return
      this.host = await native.createBrowserHost({ ...this.options, runtime: descriptor })
      this.failure = null
    } catch (error) {
      this.failure = 'The managed browser runtime is missing, incompatible, or unavailable. Repair this computer to retry.'
      this.options.reportFailure(error)
    }
  }
  async retry() {
    if (this.closed) throw new DomainError('BROWSER_RUNTIME_CLOSED', 'Browser runtime repair is unavailable during shutdown.', 503)
    if (this.host) return this.status()
    if (!this.runtimeRoot) throw new DomainError('BROWSER_RUNTIME_UNAVAILABLE', 'This installation has no managed browser runtime root.', 503)
    await this.options.assertHostOwnership()
    const staging = await import(pathToFileURL(join(this.release, 'scripts/local-production-runtime.mjs')).href)
    const staged = await staging.stageProductionBrowserRuntime({ release: this.release, appRoot: dirname(this.runtimeRoot) }) as Descriptor | null
    if (!staged) throw new DomainError('BROWSER_RUNTIME_UNAVAILABLE', 'No matching browser artifact is available in this release.', 503)
    const installer = await this.installer()
    const lifecycle = await installer.offlineBrowserRuntimeLifecycle({ nativeHostModule: staged.nativeHostModule,
      profileStateRoot: join(this.options.stateDirectory, 'browser', 'profile-data') })
    await installer.activateBrowserRuntime({ runtimeRoot: this.runtimeRoot, staged, drain: lifecycle.drain })
    await this.start()
    return this.status()
  }
  stopAdmission() { this.host?.stopAdmission() }
  async stop() { this.closed = true; await this.opening; await this.host?.close() }
}
