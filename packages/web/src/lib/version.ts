interface VersionInfo {
  name: string;
  version: string;
}

// The version is read once per page load and shared, so the footer (and any
// other reader) doesn't issue a request per render. It resolves to null when
// the API is unreachable, and the UI simply hides the version in that case.
let cached: Promise<VersionInfo | null> | null = null;

export function fetchVersion(): Promise<VersionInfo | null> {
  if (!cached) {
    cached = fetch('/api/version')
      .then((res) => (res.ok ? (res.json() as Promise<VersionInfo>) : null))
      .catch(() => null);
  }
  return cached;
}
