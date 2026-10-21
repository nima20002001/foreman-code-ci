import '@fontsource-variable/inter'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'

import { AppProviders } from './app/providers'
import { router } from './app/router'
import { initializeTheme } from './features/theme'
import './styles.css'
import './shared/ui/nocturne/legacy-bridge.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('The application root element is missing.')
}

initializeTheme()

function bootstrap(element: HTMLElement) {
  createRoot(element).render(
    <StrictMode>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  )
}

bootstrap(rootElement)
