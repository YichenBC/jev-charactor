# Reproducing development evaluations

These commands evaluate isolated fictional fixtures, not the browser's save. They do not expose a server or change the player's game. Current cases are **development cases**, not an independent test set. Programmatic acceptance is a stated task criterion, not a human naturalness or roleplay rating.

## Offline first

Use Node >=22.12 and `npm ci`. CI targets Node 22. Record the Node version used for each run.

```sh
npm run eval:release -- --dry-run
npm run eval:release -- --provider rules --repeats 3 --max-requests 72
npm run eval:release -- --provider utility --repeats 3 --max-requests 72
npm run eval:autonomy -- --provider rules --seconds 180
npm run eval:autonomy -- --provider utility --seconds 180
```

The 24 point cases cover urgent food/rest with and without a greeting, work pressure, social need, focused dialogue, returning to an earlier plan, expired evidence, and gift relationship variants, using Mei and Tang. Rationale and accepted sets are stored outside the model input. Some choices are valid but fail a narrower task criterion; for gift responses all reasonable responses are accepted and their distribution is descriptive. Do not interpret the aggregate as a personality score.

Rule and utility policies receive only the same visible input as Jev. They have shared task-matched gift/contract response rules; urgency and value-per-cost ranking differ. The delivery rule reads visible disposition traits and past player commitments: repeated breaches plus impatience can lead to rejection, a forgiving character can accept an explained delay after reliable history, and prior reliability can earn a timely-delivery tip. It uses no fixture ID or scoring label. These narrow authored social rules are transparent, not a general semantic interpreter. Baseline affects are fixed to focused and are not a competitive affect-generation model. Fixed candidate-list permutations vary by case/repeat and are identical across providers. Other context ordering remains fixed. Deterministic repeats are ordering checks, not independent stochastic samples.

## Paid model runs

Set `OPENROUTER_API_KEY` locally. No evaluation automatically falls back to rules or retries. Run a three-request smoke check before any larger batch:

```sh
npm run eval:release -- --provider jev --limit 3 --max-requests 3 --max-cost 0.50
```

A completed smoke run only covers the selected subset. The full development pilot is 24 cases:

```sh
npm run eval:release -- --provider jev --max-requests 24 --max-cost 0.50
```

General LLM comparison uses the same visible state, action criteria, reaction criteria and shared task instructions. It generates only a structured action/reaction, never the NPC's prose. Choose and freeze an explicit `EVAL_LLM_MODEL` supporting strict JSON schema before running; there is no implicit model selection.

```sh
npm run eval:release -- --provider llm --limit 3 --max-requests 3 --max-cost 0.50
```

The reported-cost limit is not a prepaid hard cap. A request can cross it; a failed request can still be billed. Missing cost, authentication/billing failures and unresolved requests are reported, and paid runs stop on unknown billing. Failed calls never count as model successes. Model response metadata is retained even for malformed answers; absent response model remains unknown, distinct from requested model.

## Artifacts and replay

Every run creates a unique directory under `artifacts/evaluation/`; `--out` may select a new directory, but an existing directory is never overwritten.

- `cases.json`: complete frozen case definitions and scoring rationale for this run.
- `manifest.json`: exact case-file hash, source commit/dirty flag, runtime, provider/model, seed, limits, completion and in-flight state.
- `records.jsonl`: append-only completed requests with exact visible input, normalized output, actual model, failures, elapsed time and reported cost.
- `summary.json`: planned/attempted/valid/acceptable counts and family breakdown; p50/p95 use nearest rank over attempted calls, including failures.
- `provenance.json`: relevant source hashes, including the prompt source.
- `execution.json`: fresh-fixture replay of valid selections, actual utterance, immediate/final progress and after-job consequences; replay never queries a model.

Recompute a point-run summary without calling any model:

```sh
npm run eval:release -- --report artifacts/evaluation/YOUR_RUN_DIRECTORY
```

Unattempted opportunities stay in the primary denominator, including family totals. A crash marker is reconciled with completed JSONL sequences; a genuinely unresolved request makes total cost unknown. Preserve partial directories and provider errors. Do not rerun into the same directory or silently discard them.

Autonomy runs write `trajectory.json` on each attempt and at the end, plus provenance and summary. All five NPCs use the chosen policy; world time is frozen during requests. The stress fixture starts one resident hungry, one tired, one socially deprived and one under work pressure. Jobs complete through normal movement/time, not teleportation or immediate rewards. Reports count completed jobs, urgent-need exposure, idle duration and wait/travel-only selections. An incomplete request-limited trajectory is explicitly incomplete. This scheduler is suitable for semantic development tests, not real-time wall-clock game-latency claims.

## Before paper claims

Freeze independent families, versions, prompt, sample size and rubrics after development. Record new labels and content-authoring effort. Add personality/history contrasts that retain multiple meaningful choices, knowledge-boundary cases in the independent cabin environment, representation/ablation controls, and blind human ratings where claiming naturalness. The current basic cases can be solved entirely by explicit rules and do not establish a Jev advantage.

## 可选的项目级 DNS

默认使用系统网络。只有确认系统 DNS 失效、且已有可信 DNS 服务器可用时，才在本机 `.env` 设置 `JEV_DNS_SERVER=<DNS服务器IP>`，或仅在实验命令的环境中传入。空值与未设置均使用原生 fetch。此配置不修改系统 DNS/代理；仍校验 OpenRouter 的 HTTPS 证书，不跟随重定向。不要将本机路由器地址作为通用默认值提交。

该配置同时作用于游戏服务、独立角色实验和研究评测。适配器只支持 OpenRouter `/api/` 请求、字符串 body、12 秒总超时与 2 MiB 响应上限；用于当前 JSON API，不支持流式聊天。403 可能来自供应商区域或模型权限限制，不能据此推断密钥失效；检查原因并保留失败记录，不用网络路由配置绕过服务限制。

## Release characterization suites

`--suite dialogue` is the original 24-case development set; `--suite social` adds 8 independent-recipient invitation fixtures; `--suite delivery` adds the existing 16-cell persona × delivery timing/temperature × history × explanation factorial probe. `--suite all` contains 48 cases. These are still authored development fixtures. The same templates repeated for two characters are not independent task families.

Gift and delivery cases carry `descriptive-only` tags. All legal responses can satisfy their mechanical criterion, so exclude these 20 cases from a need/response task-success score. Report their choice distributions and matched contrasts separately. Delivery summaries match within each recorded trial, keep failed/missing pairs, expose differing candidate sets, and compare repeat stability. A changed action is not automatically better role-playing. Timeliness and meal temperature are confounded; the timely-explanation cell is an authored intervention absent from the ordinary game menu.

```sh
npm run eval:release -- --suite all --dry-run
npm run eval:release -- --provider rules --suite all --repeats 3 --max-requests 144
npm run eval:release -- --provider utility --suite all --repeats 3 --max-requests 144
EVAL_LLM_MODEL=qwen/qwen3-235b-a22b-2507 npm run eval:release -- --provider llm --suite all --repeats 3 --max-requests 144 --max-cost 0.50
npm run eval:release -- --provider jev --suite all --repeats 3 --max-requests 144 --max-cost 0.50
```

The Qwen identifier is an explicit configuration example. Check model availability for your account and record the requested alias and actual provider response separately. Do not bypass provider regional restrictions.

UI regression: with the local server running, `npm run test:browser` starts an isolated temporary browser and intercepts all API requests with test fixtures. It does not call a paid model or touch the in-app browser save. Screenshots label this provenance.

## Recompute a frozen comparison

```sh
npm run eval:report -- PATH_TO_RULE_RUN PATH_TO_UTILITY_RUN PATH_TO_JEV_RUN PATH_TO_LLM_RUN --out artifacts/reports/NEW_NAME
```

The report rejects mismatched case-file hashes, source commits, seeds/repetition counts, dirty source, duplicate providers and records inconsistent with the frozen definitions. It recomputes task criteria from definitions instead of trusting cached scores, retains missing planned opportunities, and separates descriptive-only coverage. It does not call any provider. Output is an exclusive new directory containing `report.json` and `report.md`. This verification establishes internal consistency of supplied artifacts, not cryptographic proof of who ran them.

For CI or a clean clone, `npm run build && npm run test:browser:isolated` starts and stops its own temporary no-key server on an available local port. Install the Playwright Chromium runtime first (`npx playwright install chromium`) if absent.
