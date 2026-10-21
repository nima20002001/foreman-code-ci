import { useEffect } from 'react'
import { useGeneralSettings } from '../../shared/api/generalSettings'
import { setTheme } from './themeStore'

export function useSyncedTheme() {
  const state = useGeneralSettings()
  const theme = state.denied ? undefined : state.settings.data?.value.theme
  useEffect(() => {
    // localStorage is only a first-paint cache of Main’s last confirmed preference.
    if (theme) setTheme(theme)
  }, [theme])
  return state
}
