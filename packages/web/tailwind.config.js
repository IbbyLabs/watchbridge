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
        brand: { DEFAULT: '#5e6ad2', hover: '#6b76dd', muted: '#3b4180' },
        success: '#22c55e',
        danger: '#ef4444',
        ink: '#e7e7ea',
        muted: '#a1a1aa',
        faint: '#71717a',
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
