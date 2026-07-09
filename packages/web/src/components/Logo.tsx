import type { SVGProps } from 'react';

/**
 * Watchbridge logomark: a suspension-bridge silhouette on a brand tile. Doubles
 * as the app's favicon (see public/favicon.svg — keep the two in sync).
 */
export function Logo({ className = 'h-7 w-7', title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id="wb-logo-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b76dd" />
          <stop offset="1" stopColor="#4a55b8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#wb-logo-grad)" />
      <g fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 22h20" />
        <path d="M11 22V9" />
        <path d="M21 22V9" />
        <path d="M6 19C7.5 10 9.5 9 11 9c2 0 3.5 4 5 4s3-4 5-4c1.5 0 3.5 1 5 10" />
      </g>
    </svg>
  );
}
