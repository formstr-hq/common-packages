import type { SVGProps } from 'react';

export interface AsteriskProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  /** Width and height in pixels. Defaults to 20. */
  size?: number;
  /** Stroke width in the 24×24 viewBox. Defaults to 2. */
  strokeWidth?: number;
  /** Add the slow suite pulse. */
  pulse?: boolean;
}

/**
 * The suite mark. Six arms, round caps, currentColor — so it can sit inside a
 * logo, on a button, or in the desk's identity tile without carrying its own
 * palette.
 */
export function Asterisk({
  size = 20,
  strokeWidth = 2,
  pulse = false,
  className,
  ...rest
}: AsteriskProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      focusable="false"
      aria-hidden="true"
      className={[pulse ? 'fs-suite-pulse' : '', className].filter(Boolean).join(' ') || undefined}
      {...rest}
    >
      <g stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round">
        <line x1="12" y1="3" x2="12" y2="21" />
        <line x1="4.2" y1="7.5" x2="19.8" y2="16.5" />
        <line x1="19.8" y1="7.5" x2="4.2" y2="16.5" />
      </g>
    </svg>
  );
}
