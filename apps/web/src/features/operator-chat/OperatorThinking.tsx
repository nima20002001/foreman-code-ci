import { useId, useState } from 'react'
import { Icon } from '../../shared/ui/nocturne'

/** Keep disclosure state independent of streamed text updates. */
export function OperatorThinking({ text, onBrowse }: { text: string; onBrowse?: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  return <section className="operator-thinking">
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => { onBrowse?.(); setExpanded(!expanded) }}>
      <span>Thinking</span><Icon name="chevron" size={10} className={expanded ? 'operator-thinking-expanded' : undefined} />
    </button>
    <div className="operator-thinking-content" data-expanded={expanded} aria-hidden={!expanded} inert={!expanded}>
      <div><div id={id} role="region" aria-label="Thinking summary"><p>{text}</p></div></div>
    </div>
  </section>
}
