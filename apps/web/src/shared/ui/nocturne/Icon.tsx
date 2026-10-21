import type { SVGProps } from 'react'

// Local, original line icons: no network assets or icon-package version coupling.
const paths = {
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  chevron: 'm9 5 7 7-7 7',
  down: 'm5 9 7 7 7-7',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  play: 'm8 4 12 8-12 8V4Z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 13-2l2 2M4 17l2 2a8 8 0 0 0 13-2',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
  code: 'm8 5-7 7 7 7M16 5l7 7-7 7m-1-18-4 22',
  terminal: 'm4 6 6 6-6 6m9 0h7',
  server: 'M4 4h16v7H4zM4 13h16v7H4zM8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4',
  workflow: 'M3 3h6v6H3zM15 15h6v6h-6zM15 3h6v6h-6zM9 6h6M6 9v9h9',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  settings: 'M4 7h16M4 17h16M8 3v8M16 13v8',
  gear: 'M9.5 3h5l.6 2.5 2.2 1.3 2.5-.7 2.5 4.3-1.9 1.8v2.6l1.9 1.8-2.5 4.3-2.5-.7-2.2 1.3-.6 2.5h-5l-.6-2.5-2.2-1.3-2.5.7-2.5-4.3 1.9-1.8v-2.6L1.7 9.5l2.5-4.3 2.5.7 2.2-1.3L9.5 3Zm6 10a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z',
  shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Zm-4 10 3 3 5-6',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v.1',
  chat: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z',
  info: 'M12 11v6m0-10v.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  clock: 'M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  folder: 'M3 6h6l2 3h10v12H3V6Z',
  bot: 'M5 7h14v13H5zM12 3v4M2 11v5m20-5v5M9 11v2m6-2v2m-6 3h6',
  globe: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2c-5 5-5 15 0 20 5-5 5-15 0-20Z',
  command: 'M8 8h8v8H8zM8 8H5a3 3 0 1 1 3-3v3Zm8 0V5a3 3 0 1 1 3 3h-3Zm0 8h3a3 3 0 1 1-3 3v-3Zm-8 0v3a3 3 0 1 1-3-3h3Z',
  eye: 'M1 12S5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12Zm14 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  lock: 'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4',
  bell: 'M6 16V9a6 6 0 0 1 12 0v7l2 2H4l2-2Zm4 5h4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  spark: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',
  history: 'M3 3v6h6M3 9a9 9 0 1 1 1 10M12 7v5l4 2',
  external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
  minus: 'M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6',
  maximize: 'M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6',
  menu: 'M3 6h18M3 12h18M3 18h18',
} as const

export type IconName = keyof typeof paths
export function Icon({ name, size = 18, ...props }: Omit<SVGProps<SVGSVGElement>, 'name'> & { name: IconName; size?: number }) {
  return <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>
}
