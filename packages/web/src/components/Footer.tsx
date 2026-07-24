import type { SVGProps } from 'react';
import { IBBYLABS } from '../lib/brand.ts';

function IconDiscord(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 127.14 96.36" fill="currentColor" width="1em" height="1em" aria-hidden {...p}>
      <path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.31,60,73.31,53s5-12.74,11.43-12.74S96.33,46,96.22,53,91.08,65.69,84.69,65.69Z" />
    </svg>
  );
}

function IconKofi(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em" aria-hidden {...p}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3 6a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1h1.5a3.5 3.5 0 0 1 0 7H16v.2A4.8 4.8 0 0 1 11.2 18H8.8A4.8 4.8 0 0 1 4 13.2V6Zm13 6h1.5a1.5 1.5 0 0 0 0-3H16v3Z"
      />
    </svg>
  );
}

function IconMessage(p: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="1em"
      height="1em"
      aria-hidden
      {...p}
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
    </svg>
  );
}

const linkClass =
  'inline-flex min-h-[24px] items-center gap-1.5 rounded px-1 py-0.5 text-faint transition-colors hover:text-ink ' +
  'focus-visible:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg';

export function Footer() {
  return (
    <footer className="mt-16 border-t border-border pt-6">
      <div className="flex flex-col items-center gap-4 text-xs sm:flex-row sm:justify-between">
        <a href={IBBYLABS.siteUrl} target="_blank" rel="noreferrer" className={linkClass}>
          <img src="/ibbylabs-logo.png" alt="" aria-hidden className="h-5 w-5 rounded-full" />
          {IBBYLABS.developerCredit}
        </a>
        <nav className="flex items-center gap-4" aria-label="Contact and support">
          <a href={IBBYLABS.kofiUrl} target="_blank" rel="noreferrer" className={linkClass} title="Support on Ko-fi">
            <IconKofi /> Ko-fi
          </a>
          <a
            href={IBBYLABS.discordServerUrl}
            target="_blank"
            rel="noreferrer"
            className={linkClass}
            title="Join the Discord community"
          >
            <IconDiscord /> Community
          </a>
          <a
            href={IBBYLABS.discordDmUrl}
            target="_blank"
            rel="noreferrer"
            className={linkClass}
            title={`Message ${IBBYLABS.discordDmHandle} on Discord`}
          >
            <IconMessage /> Message me
          </a>
        </nav>
      </div>
    </footer>
  );
}
