import type { AiBotStatus, BotPurpose, ParsedRobots } from './types.js';
import { robotsMatcher } from './robots.js';

interface BotDef {
  bot: string;
  vendor: string;
  purpose: BotPurpose;
  note: string;
}

/** Known AI-related crawlers. Purposes follow vendor documentation where available; verify before relying on it. */
export const AI_BOTS: BotDef[] = [
  { bot: 'GPTBot', vendor: 'OpenAI', purpose: 'training', note: 'Collects content that may be used to train OpenAI models.' },
  { bot: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search', note: 'Indexes pages for ChatGPT search results; not used for training.' },
  { bot: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user-fetch', note: 'Fetches a page when a ChatGPT user asks about it.' },
  { bot: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training', note: 'Collects public web content that may be used for model training.' },
  { bot: 'Claude-User', vendor: 'Anthropic', purpose: 'user-fetch', note: 'Fetches a page when a Claude user asks about it.' },
  { bot: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search', note: 'Indexes content to improve Claude search result quality.' },
  { bot: 'anthropic-ai', vendor: 'Anthropic', purpose: 'training', note: 'Legacy Anthropic token; kept for older robots.txt files.' },
  { bot: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search', note: 'Indexes pages for Perplexity search results.' },
  { bot: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user-fetch', note: 'Fetches pages on behalf of a user query.' },
  { bot: 'Google-Extended', vendor: 'Google', purpose: 'training', note: 'Control token for Gemini training/grounding; does not affect Google Search ranking.' },
  { bot: 'Applebot-Extended', vendor: 'Apple', purpose: 'training', note: 'Control token for using Applebot-crawled content in Apple AI training.' },
  { bot: 'CCBot', vendor: 'Common Crawl', purpose: 'training', note: 'Builds the Common Crawl corpus widely used for model training.' },
  { bot: 'Bytespider', vendor: 'ByteDance', purpose: 'training', note: 'ByteDance crawler, reported to feed model training.' },
  { bot: 'Amazonbot', vendor: 'Amazon', purpose: 'mixed', note: 'Amazon crawler used for Alexa answers and other services.' },
  { bot: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training', note: 'Meta crawler for AI training and indexing.' },
  { bot: 'Meta-ExternalFetcher', vendor: 'Meta', purpose: 'user-fetch', note: 'Fetches links on behalf of Meta AI users.' },
  { bot: 'cohere-ai', vendor: 'Cohere', purpose: 'training', note: 'Cohere crawler token.' },
  { bot: 'DuckAssistBot', vendor: 'DuckDuckGo', purpose: 'search', note: 'Fetches pages to produce AI-assisted answers; not used for training.' },
  { bot: 'MistralAI-User', vendor: 'Mistral', purpose: 'user-fetch', note: 'Fetches pages for Le Chat user requests.' },
  { bot: 'Diffbot', vendor: 'Diffbot', purpose: 'training', note: 'Extracts structured data used for knowledge graphs and AI.' },
  { bot: 'YouBot', vendor: 'You.com', purpose: 'search', note: 'You.com search crawler.' },
];

export function analyzeAiBots(parsed: ParsedRobots | null, mode: 'rules' | 'allow-all' | 'disallow-all' = 'rules'): AiBotStatus[] {
  return AI_BOTS.map((b) => {
    if (mode === 'disallow-all') {
      return { ...b, allowed: false, partial: false, matchedBy: 'none' as const };
    }
    const m = robotsMatcher(parsed, b.bot);
    const allowed = m.isAllowed('/');
    const partial = allowed && m.rules.some((r) => r.type === 'disallow' && r.path !== '');
    return { ...b, allowed, partial, matchedBy: m.matchedBy };
  });
}
