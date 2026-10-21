import type { LegacyChatDeliveryBridge } from './legacyBridge.js'

const bridges = new WeakMap<object, LegacyChatDeliveryBridge>()
export function installChatDeliveryBridge(service: object, bridge: LegacyChatDeliveryBridge): void {
  if (bridges.has(service)) throw new Error('The common chat delivery bridge is already installed.')
  bridges.set(service, bridge)
}
/** OperatorServices uses a narrow service Pick; this accessor preserves that existing composition type. */
export function operatorDeliveryBridge(service: object): LegacyChatDeliveryBridge | undefined { return bridges.get(service) }
