import { useEffect, useState } from 'react'
import { z } from 'zod'
import { DeliveryTargetSchema, type DeliveryTarget } from '@foreman-code/contracts'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { sameDeliveryTarget } from '../../workflow-chat/draft'

const pinSchema = z.object({ target: DeliveryTargetSchema, nativeTurnId: z.string().optional() })
type Pin = z.infer<typeof pinSchema>
function read(key: string): Pin | undefined {
  try { const raw = localStorage.getItem(key); return raw ? pinSchema.parse(JSON.parse(raw)) : undefined }
  catch { return undefined /* ignore: a malformed local selection never grants a target. */ }
}

/** A draft never silently follows a successor or a different observed native turn. */
export function useDeliveryDraftPin(draftKey: string, target: DeliveryTarget | undefined, nativeTurnId: string | undefined, hasDraft: boolean) {
  const key = protectedKey('draft', `delivery-pin:${draftKey}`)
  const [saved, setSaved] = useState<{ key: string; pin?: Pin }>(() => ({ key, pin: read(key) }))
  const pin = saved.key === key ? saved.pin : read(key)
  const update = (next?: Pin) => {
    try { if (next) localStorage.setItem(key, JSON.stringify(next)); else localStorage.removeItem(key) }
    catch { /* ignore: the visible draft remains pinned for this mounted session. */ }
    setSaved({ key, pin: next })
  }
  useEffect(() => {
    if (!hasDraft && pin) update()
    else if (hasDraft && !pin && target) update({ target, nativeTurnId })
  })
  const stale = !!pin && (!target || !sameDeliveryTarget(pin.target, target) || pin.nativeTurnId !== nativeTurnId)
  return { pin, stale, refresh: () => { if (target) update({ target, nativeTurnId }) } }
}
