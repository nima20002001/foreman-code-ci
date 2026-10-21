import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cx } from './utils'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  loadingLabel?: string
  leading?: ReactNode
  trailing?: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', loading = false, loadingLabel,
  leading, trailing, className, children, disabled, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
    className={cx('n-button', `n-button--${variant}`, `n-button--${size}`, className)}>
    {loading ? <span className="n-spinner" aria-hidden="true" /> : leading}
    <span>{loading && loadingLabel ? loadingLabel : children}</span>{trailing}
  </button>
}

export function IconButton({ label, title = label, children, className, ...props }: Omit<ButtonProps, 'leading' | 'trailing'> & { label: string }) {
  return <Button {...props} aria-label={label} title={title} className={cx('n-icon-button', className)}>{children}</Button>
}

export function LinkButton({ variant = 'secondary', className, children, ...props }:
  AnchorHTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement>; variant?: ButtonProps['variant'] }) {
  return <a {...props} className={cx('n-button', `n-button--${variant}`, className)}
    rel={props.target === '_blank' ? [props.rel, 'noopener', 'noreferrer'].filter(Boolean).join(' ') : props.rel}>{children}</a>
}
