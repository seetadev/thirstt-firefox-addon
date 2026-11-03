// The ONE place that names the Thirstt backend. Keep manifest.json "host_permissions" in sync with it
// (tests/config.test.mjs fails if they drift); `npm run build:test -- --api-base <url>` rewrites both
// into a temporary copy so the add-on can be tested against a local test double.
export const API_BASE = 'https://staging.thirstt.com';
