import { IoneHarnessLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

type OfficialBrandMarkProps = HeroBrandMarkOwnerProps & SidebarBrandMarkOwnerProps

/**
 * Render the iONE Harness mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the iONE mark.
 */
export function OfficialBrandMark({ size, className }: OfficialBrandMarkProps) {
  return <IoneHarnessLogo size={size} className={className} />
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
