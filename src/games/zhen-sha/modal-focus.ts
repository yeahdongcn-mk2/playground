/**
 * Focus and background-inert contract for the Zhen Sha settlement overlay.
 *
 * The overlay is a modal surface, but it is not a native `<dialog>`: the view
 * owns the markup and shows/hides it. This module keeps the accessibility
 * contract in one small, testable place, independent of how the overlay is
 * rendered:
 *
 * - `open()` remembers the element that had focus, makes the caller-provided
 *   background elements inert, and moves focus into the modal.
 * - While open, Tab and Shift+Tab cycle through the modal's focusable elements
 *   in DOM order, wrapping at both ends, so focus cannot reach the inert shell.
 * - `close()` removes the background inert and returns focus to where it was.
 *
 * `open()` and `close()` are idempotent: repeating either call, or closing a
 * controller that was never opened, does nothing.
 */

/** Options accepted by {@link createModalFocus}. */
export interface ModalFocusOptions {
  /** Element that contains the modal's focusable content. */
  readonly container: HTMLElement;
  /** Element focused on open; defaults to the container's first focusable element. */
  readonly initialFocus?: HTMLElement | null;
  /**
   * Elements outside the modal that become inert while it is open.
   *
   * Each element must be owned by this controller: do not pass an element that
   * another layer already made inert, because {@link ModalFocusController.close}
   * removes the `inert` attribute by value rather than tracking which controller
   * added it. Callers that share a background element between layers must
   * coordinate the attribute themselves and leave this list to a single owner.
   */
  readonly background?: Iterable<HTMLElement>;
}

/** Controller returned by {@link createModalFocus}. */
export interface ModalFocusController {
  /** Whether the modal currently owns focus and Tab handling. */
  isOpen(): boolean;
  /** Opens the modal: remembers focus, inerts the background, focuses in. */
  open(): void;
  /** Closes the modal: restores the background and the previous focus. */
  close(): void;
  /** Focusable elements inside the container, in DOM (Tab) order. */
  focusables(): HTMLElement[];
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  '[tabindex]',
].join(', ');

function isHiddenByCss(element: HTMLElement): boolean {
  // `visibility` inherits, so the element's own computed value already accounts
  // for a hidden ancestor unless the element explicitly overrides it.
  if (getComputedStyle(element).visibility === 'hidden') {
    return true;
  }
  // `display: none` is not inherited, so walk up to catch a hidden ancestor.
  // This also covers the UA `[hidden] { display: none }` style; an element the
  // author deliberately re-shows through CSS stays focusable.
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') {
      return true;
    }
  }
  return false;
}

function isFocusable(element: HTMLElement): boolean {
  if (element.hasAttribute('disabled')) {
    return false;
  }
  // `closest` also covers the element itself and every ancestor, so elements
  // inside an `aria-hidden` subtree that assistive technology cannot reach are
  // skipped as well.
  if (element.closest('[aria-hidden="true"]') !== null) {
    return false;
  }
  if (isHiddenByCss(element)) {
    return false;
  }
  if (element instanceof HTMLInputElement && element.type === 'hidden') {
    return false;
  }
  const tabindex = element.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) < 0) {
    return false;
  }
  return true;
}

/**
 * Creates the settlement modal's focus controller. Nothing is mutated until
 * {@link ModalFocusController.open} is called.
 */
export function createModalFocus(options: ModalFocusOptions): ModalFocusController {
  const { container } = options;
  const background = [...(options.background ?? [])];

  let openState = false;
  let previousFocus: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(isFocusable);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!openState || event.key !== 'Tab') {
      return;
    }
    const elements = focusables();
    if (elements.length === 0) {
      return;
    }

    event.preventDefault();
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? elements.indexOf(active) : -1;
    const nextIndex =
      index === -1
        ? event.shiftKey
          ? elements.length - 1
          : 0
        : (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
    elements[nextIndex]?.focus({ preventScroll: true });
  }

  function open(): void {
    if (openState) {
      return;
    }
    openState = true;
    previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    for (const element of background) {
      element.setAttribute('inert', '');
    }
    document.addEventListener('keydown', onKeydown);

    const target = options.initialFocus ?? focusables()[0];
    target?.focus({ preventScroll: true });
  }

  function close(): void {
    if (!openState) {
      return;
    }
    openState = false;
    document.removeEventListener('keydown', onKeydown);
    for (const element of background) {
      element.removeAttribute('inert');
    }

    const restoreTarget = previousFocus;
    previousFocus = null;
    if (restoreTarget?.isConnected) {
      restoreTarget.focus({ preventScroll: true });
    }
  }

  return {
    isOpen: () => openState,
    open,
    close,
    focusables,
  };
}
