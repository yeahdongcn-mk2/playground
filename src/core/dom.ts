/** Small DOM helpers used by the app shell and game views. */

export function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Expected element not found: ${selector}`);
  }
  return element;
}

export function queryAll<T extends Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

export function setText(element: Element, text: string): void {
  element.textContent = text;
}
