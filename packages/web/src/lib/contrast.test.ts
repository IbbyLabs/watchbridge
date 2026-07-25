import { describe, expect, it } from 'vitest';
import tailwind from '../../tailwind.config.js';

/**
 * The palette is checked here rather than by eye, because a colour that reads
 * fine to one person can be unreadable to another and nothing in the build
 * catches it. WCAG 2.2 AA asks for 4.5:1 on body text, 3:1 on large text and on
 * the non-text parts of a control.
 */

const AA_TEXT = 4.5;
const AA_LARGE = 3;

const colors = tailwind.theme.extend.colors;

const hex = (path: string): string => {
  const [group, shade] = path.split('.');
  const value = colors[group!];
  if (typeof value === 'string') return value;
  return (value as Record<string, string>)[shade ?? 'DEFAULT']!;
};

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const h = color.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Flatten a translucent colour onto a ground, as the browser composites it. */
function over(color: string, ground: string, alpha: number): string {
  const parse = (c: string) => [0, 2, 4].map((i) => parseInt(c.replace('#', '').slice(i, i + 2), 16));
  const [fr, fg, fb] = parse(color);
  const [br, bg, bb] = parse(ground);
  const mix = (f: number, b: number) => Math.round(f * alpha + b * (1 - alpha));
  return `#${[mix(fr!, br!), mix(fg!, bg!), mix(fb!, bb!)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

const GROUNDS = ['bg', 'surface', 'elevated'] as const;

describe('text colours meet AA on every surface they sit on', () => {
  for (const fg of ['ink', 'muted', 'faint', 'brand.ink', 'success', 'danger'] as const) {
    for (const ground of GROUNDS) {
      it(`${fg} on ${ground}`, () => {
        expect(contrast(hex(fg), hex(ground))).toBeGreaterThanOrEqual(AA_TEXT);
      });
    }
  }
});

describe('brand text stays readable on the tint it sits on', () => {
  // The brand pill is `bg-brand/15 text-brand-ink`, so the real ground is the
  // brand at 15% over the card, not the card itself.
  for (const ground of ['surface', 'elevated'] as const) {
    it(`brand.ink on bg-brand/15 over ${ground}`, () => {
      const tint = over(hex('brand'), hex(ground), 0.15);
      expect(contrast(hex('brand.ink'), tint)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});

describe('button labels meet AA in every state', () => {
  it('white on the brand fill', () => {
    expect(contrast('#ffffff', hex('brand'))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('white on the brand fill while hovered', () => {
    expect(contrast('#ffffff', hex('brand.hover'))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('the hover state is visibly different from the resting one', () => {
    expect(contrast(hex('brand'), hex('brand.hover'))).toBeGreaterThan(1.2);
  });
});

describe('non-text UI meets the 3:1 bar', () => {
  it('the brand fill is distinguishable from every surface', () => {
    for (const ground of GROUNDS) {
      expect(contrast(hex('brand'), hex(ground))).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });

  it('status dots are distinguishable from their card', () => {
    for (const tone of ['success', 'danger', 'brand'] as const) {
      expect(contrast(hex(tone), hex('surface'))).toBeGreaterThanOrEqual(AA_LARGE);
    }
  });
});
