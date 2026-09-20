// Shared scenario model: parsing, templating, JSON-path extraction and static
// checks. Used by the server (analyze + run executor) and the client (live
// edit-time diagnostics), so both sides agree on the semantics.
//
// Semantics contract (kept in sync with README.md):
//  - Variables are referenced as {{name}} in url, header values, body and skipIf.
//  - Extracted values keep their raw JSON type (string/number/boolean/object/
//    array). When substituted into a template, strings are inserted as-is and
//    any non-string value is inserted as its JSON text.
//  - Overwrite rule: within a step, extractions apply in order (a later
//    extraction with the same name wins); across steps, a later step's
//    extraction overwrites an earlier variable with the same name.
//  - Atomicity: a step's extractions are computed first and applied as one
//    batch only if every extraction succeeds. On any failure the step applies
//    nothing: onExtractError "abort" fails the run, "skip" continues with the
//    variable store untouched. A variable is never left half-updated.
//  - skipIf: the template is resolved against current variables; the step is
//    skipped when the resolved value is boolean true or the string "true".

export type ExtractFrom = 'header' | 'json';
export type ExtractDef = {name: string; from: ExtractFrom; key: string};
export type StepDef = {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  skipIf?: string;
  onExtractError: 'abort' | 'skip';
  extract: ExtractDef[];
};
export type ScenarioDef = {steps: StepDef[]};

export type Diagnostic = {step?: string; level: 'error' | 'warning'; message: string};

export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ExtractionResult = {name: string; ok: boolean; value?: unknown; error?: string};
export type RunStepRecord = {
  stepId: string;
  index: number;
  status: StepStatus;
  error?: string;
  request?: {method: string; url: string; headers: Record<string, string>; body?: string};
  response?: {status: number; headers: Record<string, string>; body: string};
  extractions?: ExtractionResult[];
  variablesAfter?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
};
export type RunRecord = {
  id: string;
  scenarioId: string;
  revision: number;
  status: RunStatus;
  definition: ScenarioDef;
  variables: Record<string, unknown>;
  steps: RunStepRecord[];
  stepDelayMs: number;
  timeoutMs: number;
  createdAt: string;
  finishedAt?: string;
};
export type RunSummary = {
  id: string;
  scenarioId: string;
  revision: number;
  status: RunStatus;
  steps: number;
  finishedSteps: number;
  createdAt: string;
  finishedAt?: string;
};

// ---------- parsing / normalization ----------

export function parseScenario(content: string): {def?: ScenarioDef; error?: string} {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return {error: 'content is not valid JSON: ' + (err instanceof Error ? err.message : String(err))};
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {error: 'scenario must be a JSON object with a "steps" array'};
  const steps = (raw as {steps?: unknown}).steps;
  if (!Array.isArray(steps)) return {error: 'scenario must have a "steps" array'};
  const normalized: StepDef[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as unknown;
    if (s === null || typeof s !== 'object' || Array.isArray(s)) return {error: `step ${i + 1} must be an object`};
    const o = s as Record<string, unknown>;
    const id = o.id === undefined ? `step${i + 1}` : o.id;
    if (typeof id !== 'string' || !id.trim()) return {error: `step ${i + 1} has an invalid "id"`};
    if (typeof o.url !== 'string') return {error: `step "${id}" needs a string "url"`};
    const method = (typeof o.method === 'string' && o.method.trim() ? o.method : 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (o.headers !== undefined) {
      if (o.headers === null || typeof o.headers !== 'object' || Array.isArray(o.headers)) return {error: `step "${id}" has invalid "headers" (expected an object)`};
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
        if (typeof v !== 'string') return {error: `step "${id}" header "${k}" must be a string`};
        headers[k] = v;
      }
    }
    if (o.body !== undefined && typeof o.body !== 'string') return {error: `step "${id}" has invalid "body" (expected a string)`};
    if (o.skipIf !== undefined && typeof o.skipIf !== 'string') return {error: `step "${id}" has invalid "skipIf" (expected a string)`};
    const onExtractError = o.onExtractError === undefined ? 'abort' : o.onExtractError;
    if (onExtractError !== 'abort' && onExtractError !== 'skip') return {error: `step "${id}" has invalid "onExtractError" (expected "abort" or "skip")`};
    const extract: ExtractDef[] = [];
    if (o.extract !== undefined) {
      if (!Array.isArray(o.extract)) return {error: `step "${id}" has invalid "extract" (expected an array)`};
      for (const e of o.extract as unknown[]) {
        if (e === null || typeof e !== 'object' || Array.isArray(e)) return {error: `step "${id}" has an invalid extraction entry`};
        const ex = e as Record<string, unknown>;
        if (typeof ex.name !== 'string' || !ex.name.trim()) return {error: `step "${id}" has an extraction with an empty "name"`};
        if (ex.from !== 'header' && ex.from !== 'json') return {error: `step "${id}" extraction "${ex.name}" has invalid "from" (expected "header" or "json")`};
        if (typeof ex.key !== 'string' || !ex.key.trim()) return {error: `step "${id}" extraction "${ex.name}" needs a non-empty "key"`};
        extract.push({name: ex.name, from: ex.from, key: ex.key});
      }
    }
    normalized.push({
      id,
      method,
      url: o.url,
      headers,
      ...(o.body !== undefined ? {body: o.body as string} : {}),
      ...(o.skipIf !== undefined && o.skipIf !== '' ? {skipIf: o.skipIf as string} : {}),
      onExtractError,
      extract,
    });
  }
  return {def: {steps: normalized}};
}

// ---------- templating ----------

const REF_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SINGLE_REF_PATTERN = /^\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$/;

export function findRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(REF_PATTERN)) out.add(m[1]);
  return [...out];
}

function substitute(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// Renders a template to a string. Non-string values are inserted as JSON text.
// Unresolved references are left in place and reported in `missing`.
export function renderTemplate(text: string, vars: Record<string, unknown>): {text: string; missing: string[]} {
  const missing = new Set<string>();
  const out = text.replace(REF_PATTERN, (whole, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return substitute(vars[name]);
    missing.add(name);
    return whole;
  });
  return {text: out, missing: [...missing]};
}

// Resolves a template to a value: a template that is exactly one reference
// keeps the raw (possibly non-string) value; anything else renders to string.
export function resolveValue(text: string, vars: Record<string, unknown>): {value: unknown; missing: string[]} {
  const single = SINGLE_REF_PATTERN.exec(text);
  if (single) {
    if (Object.prototype.hasOwnProperty.call(vars, single[1])) return {value: vars[single[1]], missing: []};
    return {value: undefined, missing: [single[1]]};
  }
  const r = renderTemplate(text, vars);
  return {value: r.text, missing: r.missing};
}

// ---------- JSON path ----------

// Supports $.a.b[0].c, $["a b"], $[0]. Returns null for invalid syntax.
export function parseJsonPath(path: string): (string | number)[] | null {
  if (!path.startsWith('$')) return null;
  const tokens: (string | number)[] = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === '.') {
      const m = /^\.([A-Za-z_$][A-Za-z0-9_$]*)/.exec(path.slice(i));
      if (!m) return null;
      tokens.push(m[1]);
      i += m[0].length;
    } else if (path[i] === '[') {
      const num = /^\[(\d+)\]/.exec(path.slice(i));
      if (num) {
        tokens.push(Number(num[1]));
        i += num[0].length;
        continue;
      }
      const str = /^\["([^"]+)"\]|^\['([^']+)'\]/.exec(path.slice(i));
      if (str) {
        tokens.push(str[1] ?? str[2]);
        i += str[0].length;
        continue;
      }
      return null;
    } else {
      return null;
    }
  }
  return tokens;
}

export function readJsonPath(data: unknown, path: string): {ok: boolean; value?: unknown; error?: string} {
  const tokens = parseJsonPath(path);
  if (!tokens) return {ok: false, error: `invalid JSON path "${path}"`};
  let cur: unknown = data;
  for (const t of tokens) {
    if (typeof t === 'number') {
      if (!Array.isArray(cur) || t >= cur.length) return {ok: false, error: `array index [${t}] not found`};
      cur = cur[t];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, t)) {
        return {ok: false, error: `property "${t}" not found`};
      }
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return {ok: true, value: cur};
}

// ---------- static analysis ----------

export function analyzeScenario(def: ScenarioDef): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const defined = new Set<string>();
  def.steps.forEach((step, i) => {
    const sid = step.id || `step${i + 1}`;
    if (!step.url.trim()) diagnostics.push({step: sid, level: 'error', message: 'url is empty'});
    const refs = new Set<string>();
    findRefs(step.url).forEach(r => refs.add(r));
    for (const v of Object.values(step.headers)) findRefs(v).forEach(r => refs.add(r));
    if (step.body) findRefs(step.body).forEach(r => refs.add(r));
    if (step.skipIf) findRefs(step.skipIf).forEach(r => refs.add(r));
    for (const r of refs) {
      if (!defined.has(r)) diagnostics.push({step: sid, level: 'error', message: `references undefined variable "${r}"`});
    }
    const own = new Set<string>();
    for (const ex of step.extract) {
      if (own.has(ex.name)) diagnostics.push({step: sid, level: 'warning', message: `duplicate extraction "${ex.name}" in this step (last one wins)`});
      else if (defined.has(ex.name)) diagnostics.push({step: sid, level: 'warning', message: `"${ex.name}" overwrites a variable from an earlier step`});
      own.add(ex.name);
      if (ex.from === 'json' && parseJsonPath(ex.key) === null) diagnostics.push({step: sid, level: 'error', message: `invalid JSON path "${ex.key}"`});
    }
    own.forEach(n => defined.add(n));
  });
  return diagnostics;
}
