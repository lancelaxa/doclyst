/**
 * Small DOM helpers.
 *
 * Everything user-supplied that reaches the page — column headers, sheet
 * names, placeholder keys, filenames — comes from files this app was handed,
 * so none of it may be interpolated as markup. These helpers only ever set
 * `textContent`, which makes that the default rather than something each call
 * site has to remember. There is no `innerHTML` anywhere in this app.
 */

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

interface ElementOptions {
  readonly className?: string;
  /** Set as textContent, never parsed as HTML. */
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/** Replace an element's contents with the given nodes. */
export function replaceChildren(target: HTMLElement, ...children: Node[]): void {
  target.replaceChildren(...children);
}

/** Clear an element. */
export function clear(target: HTMLElement): void {
  target.replaceChildren();
}

/**
 * Yield to the browser so it can paint.
 *
 * Filling is a synchronous loop; without this the page would freeze for the
 * length of the batch and the progress bar would never move.
 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
