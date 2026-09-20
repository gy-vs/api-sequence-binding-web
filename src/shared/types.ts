export type Scalar = string | number | boolean | null;
export type JsonValue = Scalar | JsonValue[] | {[key: string]: JsonValue};

/** A single HTTP request step in a scenario. */
export interface ScenarioStep {
  id: string;
  name: string;
  enabled: boolean;
  method: string;
  url: string;
  headers: {name: string; value: string}[];
  /** Raw request body. If it parses as JSON, template strings inside it can
   * receive non-string variables (numbers/booleans/arrays/objects). */
  body: string;
  condition?: {variable: string; op: 'empty' | 'notEmpty' | 'equals' | 'notEquals'; value?: string} | null;
  /** What happens when any extractor fails for this step. */
  onExtractFailure: 'terminate' | 'skip';
  extract: {name: string; source: 'header' | 'json'; path: string}[];
}

/** Persisted scenario document. The existing `content` field holds its JSON form. */
export interface ScenarioDoc {
  kind: 'api-scenario';
  version: 1;
  initialVariables: Record<string, string>;
  steps: ScenarioStep[];
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  stepId?: string;
  message: string;
}

export interface VariableUse {
  name: string;
  /** Value at the moment this step ran (not the latest run value). */
  raw: unknown;
  /** Exactly what was substituted into the URL/header/string. */
  coerced: string;
  /** Reference was not defined for this step. */
  missing: boolean;
}

export interface RenderedRequest {
  method: string;
  url: string;
  headers: {name: string; value: string}[];
  /** Raw string actually sent. */
  body: string;
  /** Per-template-site resolution, by request location. */
  uses: {where: string; variable: VariableUse}[];
  warnings: string[];
}

/** Step outcome recorded during a run. */
export interface StepRunRecord {
  index: number;
  stepId: string;
  name: string;
  status: 'completed' | 'skipped' | 'failed' | 'cancelled';
  reason?: string;
  request?: RenderedRequest;
  response?: {status: number; headers: Record<string, string>; bodyPreview: string};
  /** Full variable snapshot just before the step. */
  variablesBefore: Record<string, unknown>;
  /** Full variable snapshot after the step (identical when skipped/aborted). */
  variablesAfter: Record<string, unknown>;
  /** Extracted values written by this step (old value included on overwrite). */
  extracted?: {name: string; value: unknown; overwrote: boolean; previous?: unknown}[];
  startedAt: string;
  endedAt: string;
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface RunRecord {
  id: string;
  scenarioId: string;
  /** Revision the running scenario was pinned to. */
  revision: number;
  status: RunStatus;
  steps: StepRunRecord[];
  /** Step plan from the pinned snapshot, so the UI can render pending steps. */
  plan: {stepId: string; name: string}[];
  failure?: {stepId: string; message: string};
  createdAt: string;
  endedAt?: string;
}
