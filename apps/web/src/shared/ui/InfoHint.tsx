import { Icon } from './nocturne/Icon'
import { Tooltip } from './nocturne/Overlays'
import './infoHint.css'

export function InfoHint({ label, children }: { label: string; children: string }) {
  return <Tooltip content={children}>
    <button type="button" className="info-hint" aria-label={`About ${label}`}>
      <Icon name="info" size={14} />
    </button>
  </Tooltip>
}
