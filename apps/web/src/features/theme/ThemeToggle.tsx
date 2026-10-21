import { Moon, Sun } from 'lucide-react'

import { Alert, Button, IconButton } from '../../shared/ui/nocturne'
import { useTheme } from './themeStore'
import { useSyncedTheme } from './useSyncedTheme'

export function ThemeToggle() {
  const theme = useTheme()
  const { settings, update, changeTheme, denied, uncertain, refresh, retry } = useSyncedTheme()
  const destination = theme === 'dark' ? 'light' : 'dark'
  const unavailable = denied || settings.isError
  const label = unavailable ? 'Theme unavailable. Read Main’s settings again.' : `Switch to ${destination} theme`
  const Icon = destination === 'light' ? Sun : Moon

  return (
    <><IconButton
      className="theme-toggle"
      label={label}
      disabled={!settings.data || unavailable || update.isPending || update.isError}
      onClick={() => changeTheme(destination)}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={2} />
    </IconButton>
      {update.isError && <Alert tone="warning" title={update.error.message}>
        <Button size="sm" disabled={update.isPending || denied} onClick={uncertain ? retry : () => void refresh()}>
          {uncertain ? 'Retry theme save' : 'Refresh theme settings'}
        </Button>
      </Alert>}
      {unavailable && <Button size="sm" onClick={() => void refresh()}>Refresh theme settings</Button>}
    </>
  )
}
