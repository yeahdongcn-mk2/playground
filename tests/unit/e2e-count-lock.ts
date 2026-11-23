/**
 * Locked Playwright manifest counts, split by project.
 *
 * `e2e-doc-counts.test.ts` compares this lock with the real
 * `playwright test --list` output and with README.md / docs/framework.md.
 * `browser-coverage-docs.test.ts` derives its WebKit expectation from the same
 * object instead of hard-coding a second copy that drifts when a spec is added
 * or removed. Update this one file when the manifest changes; both docs tests
 * then fail until the documented counts agree.
 */
export const EXPECTED_E2E_COUNTS = {
  total: 161,
  chromium: 91,
  mobile: 37,
  mobileWebkit: 33,
} as const;
