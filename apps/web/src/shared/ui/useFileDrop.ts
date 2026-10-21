import { useRef, useState, type DragEvent } from 'react'
import { createStore, useStore } from 'zustand'
import './fileDrop.css'

/** An alternate input gesture; callers retain their picker validation and upload flow. */
export function useFileDrop({ disabled = false, maxFiles, onFiles }: {
  disabled?: boolean; maxFiles?: number; onFiles: (files: File[]) => void
}) {
  const depth = useRef(0)
  const [store] = useState(() => createStore<{ dragging: boolean; dropError?: string }>(() => ({ dragging: false })))
  const { dragging, dropError } = useStore(store)
  const setDragging = (next: boolean) => store.setState({ dragging: next })
  const setDropError = (next: string | undefined) => store.setState({ dropError: next })
  const isDragging = dragging && !disabled
  function hasFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types ?? []).includes('Files')
      || event.dataTransfer.files.length > 0
  }
  const dropTargetProps = {
    'data-file-dragging': isDragging || undefined,
    onDragEnter(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event)) return
      event.preventDefault(); event.stopPropagation()
      depth.current += 1
      if (!disabled) setDragging(true)
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event)) return
      event.preventDefault(); event.stopPropagation()
      event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event)) return
      event.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setDragging(false)
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event)) return
      event.preventDefault(); event.stopPropagation()
      depth.current = 0; setDragging(false)
      if (disabled) return
      const items = Array.from(event.dataTransfer.items ?? [])
      if (items.some((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)) {
        setDropError('Folders are not supported. Drop individual files instead.'); return
      }
      const files = Array.from(event.dataTransfer.files)
      if (!files.length) { setDropError('No files could be read. Choose individual files instead.'); return }
      if (maxFiles !== undefined && files.length > maxFiles) {
        setDropError(`Choose or drop ${maxFiles === 1 ? 'one file' : `up to ${maxFiles} files`} at a time.`); return
      }
      setDropError(undefined)
      onFiles(files)
    },
  }
  return { dropTargetProps, isDragging, dropError, clearDropError: () => setDropError(undefined) }
}
