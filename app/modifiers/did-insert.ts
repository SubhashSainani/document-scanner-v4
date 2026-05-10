import { modifier } from 'ember-modifier';

export default modifier(function didInsert(element: Element, positional: unknown[]): void {
  const callback = positional[0] as ((el: HTMLElement) => void) | undefined;
  callback?.(element as HTMLElement);
});
