/** Decode an HTTP body to text, honouring BOM, Content-Type charset and <meta charset> (first 2 KiB), falling back sensibly. */

export interface Decoded {
  text: string;
  charset: string;
  /** body looks like binary data rather than text (NUL bytes) */
  binary: boolean;
}

const ALIASES: Record<string, string> = { latin1: 'windows-1252', 'iso-8859-1': 'windows-1252', ascii: 'windows-1252', 'us-ascii': 'windows-1252', utf8: 'utf-8' };

function canonical(label: string | null | undefined): string | null {
  if (!label) return null;
  const l = label.trim().replace(/^["']|["']$/g, '').toLowerCase();
  if (!l) return null;
  const mapped = ALIASES[l] ?? l;
  try {
    return new TextDecoder(mapped).encoding;
  } catch {
    return null;
  }
}

export function sniffCharset(buf: Buffer, contentType: string | null | undefined): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  const header = /charset\s*=\s*("[^"]+"|[^\s;]+)/i.exec(contentType ?? '');
  const fromHeader = canonical(header?.[1]);
  if (fromHeader) return fromHeader;
  const head = buf.subarray(0, 2048).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_:.-]+)/i.exec(head) ?? /<meta[^>]+content\s*=\s*["'][^"']*charset=([A-Za-z0-9_:.-]+)/i.exec(head);
  return canonical(meta?.[1]);
}

export function decodeBody(buf: Buffer, contentType?: string | null): Decoded {
  const binary = buf.subarray(0, 4096).includes(0) && !/^(\xff\xfe|\xfe\xff)/.test(buf.subarray(0, 2).toString('latin1'));
  const declared = sniffCharset(buf, contentType);
  if (declared) {
    try {
      return { text: new TextDecoder(declared).decode(buf), charset: declared, binary };
    } catch {
      /* fall through */
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), charset: 'utf-8', binary };
  } catch {
    // undeclared and not valid UTF-8: legacy web default
    return { text: new TextDecoder('windows-1252').decode(buf), charset: 'windows-1252', binary };
  }
}
