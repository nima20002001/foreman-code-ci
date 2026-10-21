import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../shared/ui/nocturne'

/** Shared transcript scrolling, following the Operator transcript pattern. No server data lives here. */
export function ConversationViewport({ revision, children }: {
  revision: string; children: (onBrowse: () => void) => ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [newOutput, setNewOutput] = useState(false)
  const onBrowse = () => { following.current = false }
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    if (following.current) { scroll.scrollTop = scroll.scrollHeight; setNewOutput(false) }
    else setNewOutput(true)
  }, [revision])
  useLayoutEffect(() => {
    if (!contentRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const scroll = scrollRef.current
      if (scroll && following.current) scroll.scrollTop = scroll.scrollHeight
    })
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])
  return <div className="conversation-viewport">
    <div ref={scrollRef} className="conversation-viewport-scroll" role="region" aria-label="Agent conversation transcript" tabIndex={0}
      onScroll={(event) => {
        const scroll = event.currentTarget
        following.current = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48
        setNewOutput(!following.current)
      }}>
      <div ref={contentRef}>{children(onBrowse)}</div>
    </div>
    {newOutput ? <Button size="sm" className="conversation-jump" onClick={() => {
      const scroll = scrollRef.current
      if (scroll) scroll.scrollTop = scroll.scrollHeight
      following.current = true; setNewOutput(false)
    }}>Jump to latest</Button> : null}
  </div>
}
