import type { IconProps } from './icons/props.ts'

/**
 * Render the iONE Harness product mark.
 * @param props.size - square size in px.
 * @param props.className - optional host-supplied layout class.
 * @returns the iONE Harness logo.
 */
export function IoneHarnessLogo({ size = 24, className }: IconProps) {
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
