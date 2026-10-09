import type { Action } from './types';

/** Capture the original release callback even when polling replaces a panel. */
export class SpatialPresses<Key> {
  private readonly presses = new Map<Key, { target: string; action: Action }>();

  begin(key: Key, target: string, action: Action): void {
    this.cancel(key);
    if (action.disabled) return;
    // Only one hand/controller can own a hold action at a time.
    if (action.onRelease && Array.from(this.presses.values()).some(press => press.target === target)) return;
    this.presses.set(key, { target, action });
    if (action.onRelease) action.onSelect();
  }

  end(key: Key, target?: string): void {
    const press = this.presses.get(key);
    this.presses.delete(key);
    if (!press) return;
    if (press.action.onRelease) press.action.onRelease();
    else if (press.target === target) press.action.onSelect();
  }

  cancel(key: Key): void {
    const press = this.presses.get(key);
    this.presses.delete(key);
    if (press?.action.onRelease) (press.action.onCancel ?? press.action.onRelease)();
  }

  cancelAll(): void {
    for (const key of this.presses.keys()) this.cancel(key);
  }
}

/** Wrap long output, including unbroken URLs, without discarding any characters. */
export function wrapSpatialText(text: string, measure: (text: string) => number, maxWidth: number): string[] {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { result.push(''); continue; }
    let line = '';
    for (const character of paragraph) {
      if (line && measure(line + character) > maxWidth) {
        const space = line.lastIndexOf(' ');
        if (space > line.length / 2) {
          result.push(line.slice(0, space));
          line = line.slice(space + 1) + character;
        } else {
          result.push(line);
          line = character;
        }
      } else line += character;
    }
    result.push(line);
  }
  return result;
}

/** A panel re-wraps its text every poll, and wrapping measures every character. */
export class SpatialTextWrap {
  private cache = new Map<string, string[]>();

  /** Wrap one panel's text. Only the lines passed here stay cached. */
  wrapAll(lines: string[], measure: (text: string) => number, maxWidth: number): string[] {
    const kept = new Map<string, string[]>();
    const result: string[] = [];
    for (const line of lines) {
      const key = `${maxWidth}\n${line}`;
      const wrapped = kept.get(key) ?? this.cache.get(key) ?? wrapSpatialText(line, measure, maxWidth);
      kept.set(key, wrapped);
      result.push(...wrapped);
    }
    this.cache = kept;
    return result;
  }
}
