/** Types for the Tailwind config so the palette can be asserted on in tests. */
declare const config: {
  theme: { extend: { colors: Record<string, string | Record<string, string>> } };
};
export default config;
