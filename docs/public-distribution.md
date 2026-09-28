# Public distribution scope

This repository is a clean source snapshot of Jev-Character and the Fog Harbor playable alpha. It includes the character core, host application, examples, regression tests, generic evaluation tools and selected usage documentation. It starts a new public source history.

Original private development history, research archives, experiment outputs and internal deployment records are not distributed here. They remain preserved separately; preparing this source snapshot does not alter scientific records, failures, model responses or historical provenance. This public repository is not the evidence bundle for earlier research results.

The retained candidate-comparison protocol is a tool input and describes a development study, not a claim that its historical runs can be reproduced from this distribution. Running evaluation tools creates new artifacts; reports of past runs require their original evidence and matching source snapshots.

## Status and licensing

This is a source-available software alpha. The project license is undecided; source visibility does not grant an open-source license or redistribution rights. The SDK retains `private: true` and `UNLICENSED`, and is not published to npm. Upstream dependency licenses and notices remain applicable to those dependencies. Author metadata has not been filled in without confirmation.

## Reproduce without model credentials

Use Node.js 22.12 or newer and an empty local model configuration. Do not create a `.env` for these checks. Dependency and Chromium installation require network access, but the commands below do not query a model.

```sh
npm ci
npm test
npm run test:research-tools
npm run build
npx playwright install chromium
npm run test:browser:isolated
npm run test:core-package
npm run lab:characters
npm run test:survival
npm run eval:release -- --suite all --dry-run
npm run eval:release -- --provider rules --suite all --max-requests 48
npm run eval:release -- --provider utility --suite all --max-requests 48
npm run eval:autonomy -- --provider rules --seconds 90
```

The isolated browser check uses its own temporary server and fictional fixtures. The character lab and survival checks use deterministic policies. Generated files live in ignored `artifacts/` directories. Passing these checks establishes software behavior and integration, not model superiority or human-rated character quality. Paid model evaluation is optional and documented separately in the [evaluation guide](evaluation-guide.md).
