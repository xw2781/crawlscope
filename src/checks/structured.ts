import type { CheckDef, Finding } from '../types.js';
import { def, isOkHtml } from './helpers.js';
import { validateStructuredItem, type SDProblemKind } from '../structured-data.js';

function sdCheck(kind: SDProblemKind): (ctx: Parameters<CheckDef['run']>[0]) => Finding[] {
  return (ctx) => {
    const out: Finding[] = [];
    for (const p of ctx.pages) {
      if (!isOkHtml(p)) continue;
      for (const item of p.structuredData) {
        for (const prob of validateStructuredItem(item)) {
          if (prob.kind === kind) out.push({ url: p.url, message: prob.message, details: { format: item.format, type: prob.type, properties: prob.properties } });
        }
      }
    }
    return out;
  };
}

export const structuredChecks: CheckDef[] = [
  def(
    { id: 'sd-invalid-json', severity: 'error', category: 'structured-data', title: 'JSON-LD cannot be parsed',
      description: 'A JSON-LD script block contains invalid JSON, so none of its data is usable.',
      howToFix: 'Validate the JSON (trailing commas, unescaped quotes and HTML inside strings are the usual culprits).' },
    sdCheck('invalid-json'),
  ),
  def(
    { id: 'sd-missing-context', severity: 'warning', category: 'structured-data', title: 'JSON-LD without @context',
      description: 'The JSON-LD object does not declare a vocabulary.',
      howToFix: 'Add "@context": "https://schema.org".' },
    sdCheck('missing-context'),
  ),
  def(
    { id: 'sd-invalid-context', severity: 'notice', category: 'structured-data', title: 'JSON-LD @context is not schema.org',
      description: 'The context does not reference schema.org, so search engines may ignore the markup.',
      howToFix: 'Use "@context": "https://schema.org".' },
    sdCheck('invalid-value'),
  ),
  def(
    { id: 'sd-missing-type', severity: 'warning', category: 'structured-data', title: 'JSON-LD without @type',
      description: 'The object has no @type, so its meaning is unknown.',
      howToFix: 'Add the schema.org type, e.g. "@type": "Article".' },
    sdCheck('missing-type'),
  ),
  def(
    { id: 'sd-missing-required', severity: 'error', category: 'structured-data', title: 'Structured data missing required properties',
      description: 'A supported schema.org type lacks properties needed for rich-result eligibility (per our requirements table based on Google docs).',
      howToFix: 'Add the listed properties with real values taken from the visible page content.' },
    sdCheck('missing-required'),
  ),
  def(
    { id: 'sd-missing-recommended', severity: 'notice', category: 'structured-data', title: 'Structured data missing recommended properties',
      description: 'Optional but valuable properties are absent; adding them improves richness and machine understanding.',
      howToFix: 'Add the listed properties where they apply to the page.' },
    sdCheck('missing-recommended'),
  ),
];
