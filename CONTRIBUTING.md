# Contributing

```bash
npm install
npm run lint     # tsc --noEmit
npm test         # vitest (unit + integration against test/fixtures/site)
npm run build    # tsup -> dist/
```

* Checks live in `src/checks/*.ts` and are registered in `src/checks/index.ts`. A check needs an `id`, `severity`, `category`,
  `title`, `description`, `howToFix` and a `run(ctx)` returning findings. Add unit tests in `test/unit/checks.test.ts`;
  if the fixture site should exhibit it, extend `test/fixtures/site` and the exact-issue list in `test/integration/fixture-crawl.test.ts`.
* **Clean-room**: write original wording, derived only from public specs (RFC 9309, sitemaps.org, schema.org, Google Search Central, llmstxt.org). Do not copy text, UI or assets from other crawlers.
* Tests must never crawl public sites; use the local fixture server in `test/helpers/server.ts`.
