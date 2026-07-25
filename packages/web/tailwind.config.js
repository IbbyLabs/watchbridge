/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Layered near-black surfaces (not pure OLED black).
        bg: '#08080a',
        surface: '#0e0e11',
        elevated: '#131317',
        border: '#1e1e24',
        // Indigo primary; green reserved for synced/success; red for errors.
        // `DEFAULT` is the fill (white on it reads at 4.70:1); `ink` is the text
        // form, light enough to clear 4.5:1 on every surface including the
        // bg-brand/15 pill tint; `hover` is deepened so white keeps its contrast.
        brand: { DEFAULT: '#5e6ad2', ink: '#7983da', hover: '#4a58cc', muted: '#3b4180' },
        success: '#22c55e',
        danger: '#ef4444',
        ink: '#e7e7ea',
        muted: '#a1a1aa',
        // Lifted from #71717a, which fell short of 4.5:1 on every surface.
        faint: '#7e7e88',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontVariantNumeric: ['tabular-nums'],
    },
  },
  plugins: [],
};
