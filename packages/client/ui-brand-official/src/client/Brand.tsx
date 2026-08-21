import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the iONE Harness mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the iONE mark.
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      aria-hidden="true"
    >
      <rect width="64" height="64" rx="14" fill="#1677ff" />
      <path fill="#fff" d="M16 14h8v36h-8zM31 14h17v7H39v8h8v7h-8v14h-8z" />
      <circle cx="49" cy="48" r="5" fill="#20b26b" />
    </svg>
  )
}

/**
 * Render the iONE Harness name alongside its independently slotted mark.
 * @returns the iONE Harness wordmark.
 */
export function OfficialBrandName() {
  return (
    <span
      aria-label="ione harness"
      style={{
        alignItems: 'baseline',
        color: 'var(--dsw-alias-label-primary)',
        display: 'inline-flex',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 16,
        fontWeight: 750,
        gap: 5,
        letterSpacing: '-0.035em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      <span>ione</span>
      <span style={{ color: '#1677ff', fontWeight: 650 }}>harness</span>
    </span>
  )
}
