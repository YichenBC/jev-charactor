import type { DecisionInput } from '../../server/jev.js';
export type { DecisionInput } from '../../server/jev.js';

export interface EvaluationCase {
  id: string;
  familyId: string;
  split: 'development' | 'test';
  /** Shared seed identity for explicitly paired observations; never sent to providers. */
  permutationGroup?: string;
  input: DecisionInput;
  acceptableChoices: string[];
  rationale: string;
  tags: string[];
}
export interface EvaluationResponse {
  choice: string;
  affect: string;
  latencyMs: number;
  cost?: number;
  model?: string;
  /** Exact generated speech, or null for an autonomous decision. */
  dialogue?: string | null;
  rawContent?: string | null;
  finishReason?: string | null;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** False when the provider response violates its full upstream protocol. */
  contractValid?: boolean;
}
export interface EvaluationProvider {
  id: string;
  model: string;
  paid?: boolean;
  protocolVersion?: string;
  expressionMode?: 'program' | 'generated';
  billingMode?: 'metered-api' | 'self-hosted-unmetered';
  runtimeSettings?: { backend: string; endpoint: string; requestTimeoutMs: number; maxOutputTokens: number; thinking?: boolean };
  decide(input: DecisionInput): Promise<EvaluationResponse>;
}
export interface EvaluationConfig {
  cases: EvaluationCase[];
  provider: EvaluationProvider;
  outputDir: string;
  seed: string;
  repeats: number;
  maxRequests: number;
  maxReportedCostUSD: number;
  gitRevision: string;
  gitDirty?: boolean;
  /** Immutable plain JSON persisted before the first provider call. */
  provenance?: Record<string, unknown>;
}
export type StopReason = 'request-budget' | 'reported-cost-budget' | 'unknown-billing' | 'authentication-error' | 'billing-error' | 'consecutive-errors';
export interface EvaluationRecord {
  schemaVersion: 1;
  sequence: number;
  caseId: string;
  familyId: string;
  split: EvaluationCase['split'];
  trial: number;
  permutationSeed: string;
  permutationGroup?: string;
  startedAt: string;
  finishedAt: string;
  provider: { id: string; requestedModel: string; responseModel: string | null };
  input: DecisionInput;
  scoring: { acceptableChoices: string[]; rationale: string; tags: string[] };
  response: EvaluationResponse | null;
  /** Validated transport evidence retained even when answer fields are malformed. */
  responseEvidence?: Pick<EvaluationResponse, 'rawContent' | 'finishReason' | 'tokenUsage' | 'dialogue' | 'contractValid'>;
  status: 'valid-answer' | 'invalid-answer' | 'error';
  errorCode: string | null;
  acceptable: boolean;
  /** Wall-clock duration of the full provider call, including parsing. */
  latencyMs: number;
  costUSD: number | null;
}
export interface EvaluationMetrics {
  plannedCount: number;
  attemptedCount: number;
  unattemptedCount: number;
  validAnswerCount: number;
  failureCount: number;
  acceptableCount: number;
  validAnswerRate: number | null;
  acceptableRateAllTrials: number | null;
  acceptableRateValidAnswers: number | null;
  latencyMs: { p50: number | null; p95: number | null };
  knownCostUSD: number;
  totalCostUSD: number | null;
  knownCostCount: number;
  unknownCostCount: number;
  /** Requests with a checkpoint but no completed JSONL record; billing is unresolved. */
  outstandingRequestCount: number;
  failures: Record<string, number>;
}
export interface EvaluationSummary extends EvaluationMetrics {
  byFamily: Record<string, EvaluationMetrics>;
}
export interface EvaluationManifest {
  schemaVersion: 1;
  caseDefinitionsSha256: string;
  createdAt: string;
  updatedAt: string;
  gitRevision: string;
  gitDirty: boolean | null;
  runtime: { node: string; platform: string; arch: string };
  provider: { id: string; model: string; paid: boolean; protocolVersion: string | null };
  config: { seed: string; repeats: number; maxRequests: number; maxReportedCostUSD: number; concurrency: 1; retries: 0; optionOrder: string };
  cases: { id: string; familyId: string; split: EvaluationCase['split'] }[];
  plannedCount: number;
  actualCount: number;
  complete: boolean;
  stopReason: StopReason | null;
  inFlight: { caseId: string; trial: number; sequence: number } | null;
  budget: { knownCostUSD: number; unknownCostCount: number; overshootUSD: number; note: string };
}
export interface EvaluationResult {
  manifest: EvaluationManifest;
  records: EvaluationRecord[];
  summary: EvaluationSummary;
}
