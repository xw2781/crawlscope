import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();

/** Read a bundled web asset (src/web/* in development, dist/web/* when built). */
export function webAsset(name: string): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = readFileSync(new URL(`./web/${name}`, import.meta.url), 'utf8');
    cache.set(name, v);
  }
  return v;
}
