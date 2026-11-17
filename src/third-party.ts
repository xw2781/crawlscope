import type { PageRecord, ThirdPartyCategory, ThirdPartyHost, ThirdPartyInventory } from './types.js';

interface KnownHost { category: ThirdPartyCategory; /** snippet is generated/changed server-side, so SRI is not usable */ dynamic: boolean }

/** Small built-in list (no network lookups). Matches the host or any subdomain of it. */
const KNOWN: Record<string, KnownHost> = {
  'cdn.optimizely.com': { category: 'experimentation', dynamic: true },
  'optimizely.com': { category: 'experimentation', dynamic: true },
  'googletagmanager.com': { category: 'tag-manager', dynamic: true },
  'tags.tiqcdn.com': { category: 'tag-manager', dynamic: true },
  'assets.adobedtm.com': { category: 'tag-manager', dynamic: true },
  'cdn.segment.com': { category: 'tag-manager', dynamic: true },
  'cdn.tealiumiq.com': { category: 'tag-manager', dynamic: true },
  'dynamicyield.com': { category: 'experimentation', dynamic: true },
  'cdn.vwo.com': { category: 'experimentation', dynamic: true },
  'dev.visualwebsiteoptimizer.com': { category: 'experimentation', dynamic: true },
  'abtasty.com': { category: 'experimentation', dynamic: true },
  'cdn-4.convertexperiments.com': { category: 'experimentation', dynamic: true },
  'google-analytics.com': { category: 'analytics', dynamic: true },
  'analytics.google.com': { category: 'analytics', dynamic: true },
  'cdn.mxpnl.com': { category: 'analytics', dynamic: false },
  'static.hotjar.com': { category: 'analytics', dynamic: true },
  'script.hotjar.com': { category: 'analytics', dynamic: true },
  'cdn.heapanalytics.com': { category: 'analytics', dynamic: true },
  'plausible.io': { category: 'analytics', dynamic: false },
  'js.hs-scripts.com': { category: 'analytics', dynamic: true },
  'connect.facebook.net': { category: 'advertising', dynamic: true },
  'googleadservices.com': { category: 'advertising', dynamic: true },
  'googlesyndication.com': { category: 'advertising', dynamic: true },
  'doubleclick.net': { category: 'advertising', dynamic: true },
  'snap.licdn.com': { category: 'advertising', dynamic: true },
  'analytics.tiktok.com': { category: 'advertising', dynamic: true },
  'cdn.cookielaw.org': { category: 'consent', dynamic: true },
  'consent.cookiebot.com': { category: 'consent', dynamic: true },
  'cdn.jsdelivr.net': { category: 'cdn', dynamic: false },
  'cdnjs.cloudflare.com': { category: 'cdn', dynamic: false },
  'unpkg.com': { category: 'cdn', dynamic: false },
  'ajax.googleapis.com': { category: 'cdn', dynamic: false },
  'code.jquery.com': { category: 'cdn', dynamic: false },
  'platform.twitter.com': { category: 'social', dynamic: true },
  'platform.linkedin.com': { category: 'social', dynamic: true },
  'widget.intercom.io': { category: 'support-chat', dynamic: true },
  'js.intercomcdn.com': { category: 'support-chat', dynamic: true },
  'js.driftt.com': { category: 'support-chat', dynamic: true },
  'static.zdassets.com': { category: 'support-chat', dynamic: true },
  'browser.sentry-cdn.com': { category: 'monitoring', dynamic: false },
  'js.datadoghq.com': { category: 'monitoring', dynamic: false },
  'cdn.logrocket.io': { category: 'monitoring', dynamic: true },
  'js.stripe.com': { category: 'payments', dynamic: true },
  'www.paypal.com': { category: 'payments', dynamic: true },
  'player.vimeo.com': { category: 'video', dynamic: true },
  'www.youtube.com': { category: 'video', dynamic: true },
};

export function knownHost(host: string): KnownHost | null {
  const h = host.toLowerCase();
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const k = KNOWN[parts.slice(i).join('.')];
    if (k) return k;
  }
  return null;
}

/** Does this host serve snippets that change without notice (so SRI is impractical)? */
export const isDynamicSnippetHost = (host: string): boolean => knownHost(host)?.dynamic ?? false;

export function buildThirdPartyInventory(pages: PageRecord[]): ThirdPartyInventory {
  const hosts = new Map<string, { pages: Set<string>; scripts: number; withSri: number; urls: Set<string>; insecure: boolean }>();
  let totalScripts = 0, third = 0, thirdSri = 0, scanned = 0;
  const pagesWith = new Set<string>();
  const csp = { enforced: 0, reportOnly: 0, none: 0 };
  for (const p of pages) {
    if (!p.isHtml || p.status !== 200 || p.fetchError) continue;
    scanned++;
    if (p.csp?.enforced) csp.enforced++;
    else if (p.csp?.reportOnly) csp.reportOnly++;
    else if (p.csp) csp.none++;
    for (const s of p.scripts ?? []) {
      totalScripts++;
      if (!s.thirdParty) continue;
      third++;
      if (s.sri) thirdSri++;
      pagesWith.add(p.url);
      let h = hosts.get(s.host);
      if (!h) hosts.set(s.host, (h = { pages: new Set(), scripts: 0, withSri: 0, urls: new Set(), insecure: false }));
      h.pages.add(p.url);
      h.scripts++;
      if (s.sri) h.withSri++;
      if (h.urls.size < 3) h.urls.add(s.url);
      if (s.url.startsWith('http:')) h.insecure = true;
    }
  }
  const list: ThirdPartyHost[] = [...hosts].map(([host, h]) => {
    const k = knownHost(host);
    return {
      host, category: k?.category ?? null, dynamic: k?.dynamic ?? false, pages: h.pages.size, scripts: h.scripts, withSri: h.withSri,
      sriCoverage: Math.round((h.withSri / h.scripts) * 100) / 100, exampleScripts: [...h.urls], examplePages: [...h.pages].slice(0, 3), insecure: h.insecure,
    };
  }).sort((a, b) => b.pages - a.pages || a.host.localeCompare(b.host));
  return { pagesScanned: scanned, hosts: list, totalScripts, thirdPartyScripts: third, thirdPartyWithSri: thirdSri, pagesWithThirdParty: pagesWith.size, csp };
}
