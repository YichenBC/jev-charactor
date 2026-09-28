# Contributing

Use Node.js 22.12 or newer and the committed npm lockfile. CI targets Node 22. This source-available alpha has no selected open-source license; see [distribution scope](docs/public-distribution.md).

```sh
npm ci
npm test
npm run build
npm run test:core-package
npm run lab:characters
npm run test:survival
npm run eval:release -- --dry-run
```

These commands do not call a model. Keep model credentials in local `.env`, never in browser code, test fixtures, commits or exported logs. CI has no model credentials. An upstream outage must be recorded as an error; do not silently replace a Jev result with rules.

Core state and runtime code lives in `src/character`. Game rules, facts, text and consequences belong in adapters or `src/sim`. Changes to one game must not introduce its character names or coordinates into the core API. Give new behavior a meaningful failure test and verify actual state consequences, interruption and save/load compatibility.

Evaluation fixtures currently belong to development. If a test scenario informs a method change, it is no longer held out. Keep scenario definitions, candidate sets, sources, failures and unattempted opportunities in released evidence. Unit tests and deterministic demonstrations do not establish model roleplay quality.

Keep dependency notices and distribution documentation accurate. Licensing, authorship and publishing the SDK require explicit owner decisions; do not treat an ordinary code change as authorization for a new release.
