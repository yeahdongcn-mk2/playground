/** Small DOM helpers used by the app shell and game views. */

export function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element not found: ${selector}`);
  }
  return element;
}

export function setText(element: Element, text: string): void {
  element.textContent = text;
}

/** Escape trusted-but-not-injected strings before building HTML templates. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
