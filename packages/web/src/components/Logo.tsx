import type { ImgHTMLAttributes } from 'react';

/**
 * Watchbridge logomark: a suspension-bridge silhouette on a brand tile, loaded
 * from public/favicon.svg so the header and the favicon are one file.
 */
export function Logo({ className = 'h-7 w-7', title, ...props }: ImgHTMLAttributes<HTMLImageElement> & { title?: string }) {
  return (
    <img
      src="/favicon.svg"
      className={className}
      alt={title ?? ''}
      aria-hidden={title ? undefined : true}
      width={32}
      height={32}
      decoding="async"
      {...props}
    />
  );
}
