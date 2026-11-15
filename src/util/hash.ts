import { createHash } from 'node:crypto';

export const sha256Short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

function fnv64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK;
  }
  // extra avalanche (splitmix-ish) so near-identical shingles spread across bits
  h ^= h >> 33n;
  h = (h * 0xff51afd7ed558ccdn) & MASK;
  h ^= h >> 33n;
  return h;
}

/** 64-bit simhash over word 3-shingles. Returns 16 hex chars, or null if text is too short. */
export function simhash(text: string, maxWords = 4000): string | null {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, maxWords);
  if (words.length < 3) return null;
  const v = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < words.length; i++) {
    const h = fnv64(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
