import type { DevicePresence } from './deviceEndpoint.js'

/** Connectivity evidence is scoped to the exact authenticated connection. It
 * never invents readiness, execution authority or installed provider state. */
export class ProductionDevicePresence {
  private readonly views = new Map<string, DevicePresence>()
  private readonly retiredEpochs = new Map<string, Set<string>>()
  private closed = false
  constructor(private readonly mainId: string) {}
  publish(view: DevicePresence): void {
    if (view.binding.mainId !== this.mainId) throw new Error('Device presence belongs to another main.')
    if (this.closed) return
    if (this.retiredEpochs.get(view.binding.deviceId)?.has(view.binding.connectionEpoch)) return
    const prior = this.views.get(view.binding.deviceId)
    if (view.phase === 'offline') {
      if (!prior || prior.binding.connectionEpoch !== view.binding.connectionEpoch
        || prior.binding.connectionGeneration !== view.binding.connectionGeneration
        || prior.binding.bootId !== view.binding.bootId) return
    } else if (prior && (view.binding.authorizationRevision < prior.binding.authorizationRevision
      || view.binding.keyRevision < prior.binding.keyRevision
      || (prior.binding.connectionEpoch === view.binding.connectionEpoch && view.binding.connectionGeneration < prior.binding.connectionGeneration))) return
    if (prior && prior.binding.connectionEpoch !== view.binding.connectionEpoch) {
      // Supervisor generations reset on service restart; fence replaced authenticated epochs instead.
      const retired = this.retiredEpochs.get(view.binding.deviceId) ?? new Set<string>()
      retired.add(prior.binding.connectionEpoch)
      this.retiredEpochs.set(view.binding.deviceId, retired)
    }
    this.views.set(view.binding.deviceId, structuredClone(view))
  }
  get(deviceId: string): DevicePresence | null { return structuredClone(this.views.get(deviceId) ?? null) }
  close(): void {
    this.closed = true
    for (const view of this.views.values()) { view.phase = 'offline'; view.dispatch = false; view.transfer = false }
  }
}
