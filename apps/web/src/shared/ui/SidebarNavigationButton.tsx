import { createLink } from '@tanstack/react-router'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'

type NavigationButtonProps = ComponentPropsWithoutRef<'button'> & { href?: string }

const NavigationButton = forwardRef<HTMLButtonElement, NavigationButtonProps>(
  function NavigationButton({ href, onClick, onAuxClick, className, ...props }, ref) {
    return <button {...props} ref={ref} type="button"
      className={`sidebar-navigation-button${className ? ` ${className}` : ''}`}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          event.preventDefault()
          if (href) window.open(href, '_blank', 'noopener')
          return
        }
        // createLink supplies TanStack's navigate() handler and route options.
        onClick?.(event)
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event)
        if (event.button !== 1 || event.defaultPrevented) return
        event.preventDefault()
        if (href) window.open(href, '_blank', 'noopener')
      }} />
  },
)

export const SidebarNavigationButton = createLink(NavigationButton)
