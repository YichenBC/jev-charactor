# Research-preview comparison protocol

Distribution note: retained as an input to the candidate tooling. Historical evidence and original source revisions referenced below are not included in this public source snapshot; see [public distribution scope](../public-distribution.md). The protocol and its recorded continuation accounting are preserved rather than rewritten as new results.

Prepared before the candidate comparison. This is a bounded development characterization supporting a systems feasibility report. It is not preregistered, independently held out or powered to establish quality superiority/noninferiority. Earlier batches, failed calls and calibration remain separate.

## Question and conditions

Can the portable character interfaces, host simulation and procedural expression execute situated character behavior with a decision-only model? Character behavior is separated into autonomous activity and player-facing grounded dialogue. Identity, knowledge boundaries and action consequences constrain both.

Three primary conditions share the same host and initial state:

1. Jev 1.13 selecting action and reaction, with program speech.
2. Self-hosted Kimi K3 selecting action and reaction, with the same program speech.
3. The same Kimi K3 selecting action, reaction and generated speech.

Rules and utility are offline engineering reference policies. They are not deliberately weak LLM baselines. A full-character autonomy call requires `dialogue:null`; that experiment measures activity policy, not model-generated NPC-to-NPC conversations. New authored prospective methods and reasons are equally available in structured character context to all conditions. The finite legal action set, state transitions, disclosure rules and expression material are contributions of the system/author, not abilities attributed solely to Jev.

Candidate `semantic-v1` projection removes the `Say:` segment, but the shared `self.authoredPlanDialogue` field contains authored prose fragments for prospective methods/reasons and current evidence. All conditions can use them. This is not a template-free input condition, nor an ablation isolating author content from model ability. The added profile table contains four precise goal definitions and four method/reason pairs; authoring time was not measured.

## Frozen inventory

- Interaction scenarios: `mei-continuity`, `mei-needs-feedback`, `tang-continuity`, `tang-needs-feedback`, `lin-continuity`, `lin-needs-feedback`, `lan-continuity`, `lan-needs-feedback`, in that order.
- One run per scenario per primary condition. Seed `candidate-interactions-v1`. Initial worlds and scripted player events are identical across conditions; following decisions, histories may diverge. No outcome is selected from repeated samples.
- Evaluated actor gets only the script's autonomous opportunities; other residents use fixed rule peers. Missing options or busy actors count as skipped scheduled opportunities, not successful replies. Lin/Lan's unavailable second-level follow-up remains visible.
- Separate whole-world autonomy: one 90-second stress trajectory per primary condition, seed `candidate-autonomy-v1`, all five residents use the same provider. World time freezes during inference, 0.25-second simulation tick. This is not a real-time scheduler/stress demonstration.
- Offline rules and utility run the same inventory for engineering comparison. They are not added to model quality denominators.

The batch manifest records the immutable source revision, scenario/source hashes, exact run order, requested model and runtime settings before any new inference. Source must be clean at start. Do not revise prompts or templates inside this batch. A critical defect leads to preserving the batch and starting a new identified development batch, not silently repairing earlier outcomes.

## Operating points and bounds

Kimi uses verified `thinking=false`, temperature 0, output ceiling 2048 tokens, 120-second request deadline, sequential requests and zero retries. Both Kimi modes use the same backend/configuration; the full condition may produce longer outputs and accumulated histories. Calibration showed both could complete the initial Mei scenario; this does not guarantee all later scenarios.

Jev uses its native action/reaction protocol and existing 12-second transport deadline. No AR completion-token ceiling is invented for Jev. The native backend and H20 service differ in hardware, routing, queueing and serialization. Report full measured request time, not pure inference FLOPs or causal architecture speedup. A timeout is a deployment failure under its declared operating point.

Per primary condition: at most 12 requests per interaction run and 50 for autonomy, hence at most **146 requests**; all primary conditions combined at most **438**. Process one run at a time. The Jev phase has a cumulative known-charge stop of **USD 1.00** and a per-run stop no greater than the remaining cap; check returned billing after each call through the runner. One in-flight request can exceed a reported-charge threshold. A missing Jev bill stops the batch; never infer zero cost. Kimi self-hosted infrastructure cost remains unmeasured/null, even when usage tokens are available. Do not allocate new GPUs or alter the shared service.

Stop the entire live batch at its first failed/incomplete trajectory, invalid answer, unknown paid billing or request/cost truncation; preserve outputs and unattempted cells. Diagnose before deciding on a separately identified continuation. No silent retries, fallback policy substitution, extra cherry-picked probes or outcome-dependent replacement.

## Measurements and analysis

Report each scenario and condition, with denominators:

- Completed trajectories and simulation seconds; attempted, valid/applied and failed decisions; skipped scheduled opportunities with reasons; unresolved in-flight calls.
- Actual autonomous activities initiated/completed, per-resident hunger/energy exposure and idle seconds in whole-world traces. Idle includes cooldown; a single social completion is one shared event benefiting two actors. Truncated runs are not ranked using raw event counts against complete runs.
- Changed needs, gift inventory, work/goal receipts and world feedback; mechanically executed changes are separate from spoken claims.
- Request p50/p95/max, total request time, reported prompt/completion/total tokens and missing-usage count; Jev fields unavailable at the provider boundary remain unavailable. Small-sample p95 may equal the maximum and is not a stable tail estimate.
- Known API charge subtotal, unknown-charge count and total/null. Self-hosted cost is not converted into a commercial equivalent or described as free.

Use scenario/whole trajectory as the interpretive unit. Do not treat eleven correlated conversation turns as eleven independent role-playing samples. Descriptive summaries are appropriate; no unsupported significance, confidence interval or superiority percentage is required. Quality is not compressed into a weighted automatic score.

For dialogue, prepare all returned conversations for review with separate evidence: answers the actual question, topic/subject continuity, added information, factual statements versus prospective ideas, unsupported completed events, and nonexecuted promises. A reasonable future creative idea is not automatically a hallucination because it is absent from enumerated facts. Conversely, an unsupported past event is not excused merely as personality. Length, authored-content additions and single-legal-reply opportunities are explicit confounds.

Provide an anonymized, randomized whole-conversation rating packet and a separate private condition key. No human ratings exist unless actual people submit them; the agent must not fabricate or stand in for independent raters. Without those ratings, omit perceptual naturalness, personality superiority and quality noninferiority claims. Author inspection can motivate fixes and show concrete counterexamples, but must be labeled unblinded qualitative analysis.

## Evidence and publication

Store every attempted run's provenance, trajectory, summary and transcript, plus explicit unattempted manifest entries. Replay in the original source snapshot without calling a model, verify checksums and recalculate tables. Failure evidence receives the same preservation as successes. Public distribution uses a separately hashed sanitized derivative removing infrastructure metadata without changing decision inputs, outputs or outcomes.

The resulting candidate may support a limited feasibility paper even with mixed results. Final wording follows the evidence. Public visibility, license grants, author metadata and arXiv submission remain concrete owner decisions after the candidate is prepared; see [public distribution scope](../public-distribution.md).

## Declared continuation after initial transport failure

The initial `ad3b9b1` batch is preserved in `research/candidate-initial-20260927/`. It stopped on the fifth Kimi selector request after 4.36 seconds; the cause was not captured, and read-only service checks subsequently succeeded. The separate continuation reruns the full fixed inventory once, without changing scientific prompts, templates, scenarios or decision contracts. Initial results remain a separate development batch, not overwritten or pooled as independent replicates.

The continuation source adds UI text escaping, consistent API Origin checking and a CLI cap override only. Its `--max-cost 0.995556736` subtracts the initial USD 0.004443264 charge from the same USD 1.00 phase ceiling. The runner rejects a cap above USD 1.00; accounting across separate batches is additionally audited in the research report. Both source revisions are retained. A further failure stops again; no silent retries.

## Declared independent-cell coverage phase (before further comparison)

The first two stop-first batches remain separately reported failed development batches. The second stopped after nine valid selector calls; the cause remains unknown. A subsequent explicitly diagnostic 11-call selector trajectory completed; it used instrumented, dirty development source, is excluded from comparison, and does not repair either failure.

To obtain coverage without selecting successful repeats, the next named **coverage batch** executes the same 27 independent cells in the same fixed order, exactly once each. The only methodological change is declared failure isolation: a finalized incomplete self-hosted Kimi cell remains incomplete and is not retried, but the batch proceeds to the next independent cell. Complete and failed denominators are both reported. A batch with any incomplete cell is labelled `finished-with-incomplete-runs`, never complete. This is a new development protocol, not a preregistered primary result or a pooled replicate of earlier pilots.

Unknown paid billing, a paid incomplete trajectory, unresolved child checkpoint, malformed accounting, source changes and runner errors still stop the batch. The same per-cell request caps, temperature, thinking, tokens, timeouts, scenarios, prompts and program rules apply. The same cumulative Jev phase ceiling remains USD 1.00; the coverage CLI uses `--max-cost 0.991113472 --continue-unmetered` after subtracting both earlier charges. No new paid account query, hidden retries, response replacement or new GPU allocation is introduced. Diagnostic Kimi infrastructure usage remains unmeasured and is reported separately.
