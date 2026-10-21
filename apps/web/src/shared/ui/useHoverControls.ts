import { useEffect, useRef, useState } from 'react'

/** Keep controls reachable while the pointer crosses a small gap outside their owner. */
export function useHoverControls() {
  const [hovered, setHovered] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  function onPointerEnter() {
    clearTimeout(timer.current)
    setHovered(true)
  }

  function onPointerLeave() {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHovered(false), 160)
  }

  function clearHover() {
    clearTimeout(timer.current)
    setHovered(false)
  }

  return { hovered, onPointerEnter, onPointerLeave, clearHover }
}
