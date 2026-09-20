import type {
  Diagnostic, JsonValue, RenderedRequest, ScenarioDoc, ScenarioStep, VariableUse,
} from './types';

const NAME_SOURCE = '[A-Za-z_$][\\w$]*';
export const TEMPLATE_RE = new RegExp(`\\{\\{\\s*(${NAME_SOURCE})\\s*\\}\\}`, 'g');
const NAME_RE = new RegExp(`^${NAME_SOURCE}$`);

// ---------------------------------------------------------------------------
// Document parsing / normalization
// ---------------------------------------------------------------------------

export interface ParsedDoc {
  doc: ScenarioDoc | null;
  diagnostics: Diagnostic[];
}

/** Parse persisted `content`. Legacy free-text or invalid JSON yields a
 * non-scenario result with an explanatory diagnostic (old flow still works). */
export function parseScenario(content: string): ParsedDoc {
  const text = content ?? '';
  let value: unknown;
  try {
    value = text.trim() ? JSON.parse(text) : {};
  } catch {
    return {doc: null, diagnostics: [{severity: 'info', message: '内容不是场景 JSON，按纯文本处理。'}]};
  }
  const root = (value ?? {}) as Partial<ScenarioDoc>;
  if (!root || typeof root !== 'object' || Array.isArray(root) || root.kind !== 'api-scenario') {
    return {doc: null, diagnostics: [{severity: 'info', message: '内容不是场景文档（缺少 kind: api-scenario）。'}]};
  }
  const diagnostics: Diagnostic[] = [];
  const initialVariables: Record<string, string> = {};
  if (root.initialVariables && typeof root.initialVariables === 'object' && !Array.isArray(root.initialVariables)) {
    for (const [key, val] of Object.entries(root.initialVariables as Record<string, unknown>)) {
      initialVariables[key] = val === null || val === undefined ? '' : String(val);
    }
  }
  const rawSteps = Array.isArray(root.steps) ? root.steps : [];
  const steps: ScenarioStep[] = rawSteps.map((raw, index) => normalizeStep(raw, index));
  return {doc: {kind: 'api-scenario', version: 1, initialVariables, steps}, diagnostics};
}

const CONDITION_OPS = ['empty', 'notEmpty', 'equals', 'notEquals'] as const;

function normalizeStep(raw: unknown, index: number): ScenarioStep {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<ScenarioStep>;
  const stepId = typeof source.id === 'string' && source.id ? source.id : `step-${index + 1}`;
  const headers = Array.isArray(source.headers)
    ? source.headers
      .filter((header): header is {name: string; value: string} => !!header && typeof header === 'object')
      .map(header => ({name: String(header.name ?? ''), value: String(header.value ?? '')}))
    : [];
  const extractRaw: unknown[] = Array.isArray(source.extract) ? source.extract : [];
  const extract: ScenarioStep['extract'] = extractRaw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({
      name: String(item.name ?? ''),
      source: item.source === 'header' ? 'header' as const : 'json' as const,
      path: String(item.path ?? ''),
    }));
  let condition: ScenarioStep['condition'] = null;
  if (source.condition && typeof source.condition === 'object') {
    const rawCondition = source.condition as {variable?: unknown; op?: unknown; value?: unknown};
    const op = CONDITION_OPS.includes(rawCondition.op as typeof CONDITION_OPS[number])
      ? rawCondition.op as typeof CONDITION_OPS[number]
      : 'notEmpty';
    condition = {
      variable: String(rawCondition.variable ?? ''),
      op,
      value: rawCondition.value === undefined ? '' : String(rawCondition.value),
    };
  }
  return {
    id: stepId,
    name: String(source.name ?? `Step ${index + 1}`),
    enabled: source.enabled !== false,
    method: String(source.method ?? 'GET').toUpperCase(),
    url: String(source.url ?? ''),
    headers,
    body: String(source.body ?? ''),
    condition,
    onExtractFailure: source.onExtractFailure === 'skip' ? 'skip' : 'terminate',
    extract,
  };
}

// ---------------------------------------------------------------------------
// JSON path: $, .foo.bar, ["a b"], [0], [*]
// ---------------------------------------------------------------------------

export type PathTokens = (string | number | {wildcard: true})[];

export function compileJsonPath(path: string): {tokens: PathTokens} | {error: string} {
  const trimmed = path.trim();
  if (!trimmed) return {error: 'JSON 路径为空'};
  let pos = trimmed.startsWith('$') ? 1 : 0;
  const tokens: PathTokens = [];
  if (!'$.['.includes(trimmed[0])) {
    return {error: `JSON 路径必须以 $、. 或 [ 开头：${path}`};
  }
  while (pos < trimmed.length) {
    const ch = trimmed[pos];
    if (ch === '.') {
      pos += 1;
      let name = '';
      while (pos < trimmed.length && !'.['.includes(trimmed[pos])) {
        name += trimmed[pos];
        pos += 1;
      }
      if (!name) return {error: `JSON 路径含有空字段名：${path}`};
      tokens.push(name);
    } else if (ch === '[') {
      const close = trimmed.indexOf(']', pos);
      if (close === -1) return {error: `JSON 路径缺少 ]：${path}`};
      const inner = trimmed.slice(pos + 1, close);
      if (inner === '*') {
        tokens.push({wildcard: true});
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push(Number(inner));
      } else if (/^(['"]).*\1$/.test(inner)) {
        tokens.push(inner.slice(1, -1));
      } else {
        return {error: `JSON 路径的 [] 内只能是索引、* 或带引号的键：${path}`};
      }
      pos = close + 1;
    } else {
      return {error: `JSON 路径无法解析（位置 ${pos}）：${path}`};
    }
  }
  return {tokens};
}

export function evalJsonPath(root: unknown, path: string): {found: true; values: unknown[]} | {found: false; error: string} {
  const compiled = compileJsonPath(path);
  if ('error' in compiled) return {found: false, error: compiled.error};
  let current: unknown[] = [root];
  for (const token of compiled.tokens) {
    const next: unknown[] = [];
    for (const value of current) {
      if (typeof token === 'object') {
        // wildcard: non-array is a failure (not silently empty)
        if (!Array.isArray(value)) {
          return {found: false, error: `${path}：在非数组上使用了 [*]`};
        }
        next.push(...value);
      } else if (typeof token === 'number') {
        if (!Array.isArray(value)) return {found: false, error: `${path}：在非数组上使用了索引`};
        if (token < 0 || token >= value.length) {
          return {found: false, error: `${path}：数组索引 ${token} 越界（长度 ${value.length}）`};
        }
        next.push(value[token]);
      } else {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return {found: false, error: `${path}：在非对象上取字段 ${token}`};
        }
        if (!Object.prototype.hasOwnProperty.call(value, token)) {
          return {found: false, error: `${path}：缺少字段 ${token}`};
        }
        next.push((value as Record<string, unknown>)[token]);
      }
    }
    current = next;
  }
  return {found: true, values: current};
}

// ---------------------------------------------------------------------------
// Variable coercion & templating
// ---------------------------------------------------------------------------

/** Substitution rule, uniform across URL/headers/string bodies:
 * objects/arrays -> JSON; null/undefined -> empty. Values are never assumed to
 * be strings; native type is preserved when a placeholder fills a whole JSON
 * value position in the body. */
export function coerceValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

interface Resolver {
  makeUse(name: string): VariableUse;
}

function createResolver(variables: Record<string, unknown>, warnings: string[]): Resolver {
  return {
    makeUse(name) {
      const defined = Object.prototype.hasOwnProperty.call(variables, name);
      if (!defined) {
        warnings.push(`变量 {{${name}}} 未定义，已替换为空字符串。`);
        return {name, raw: undefined, coerced: '', missing: true};
      }
      const raw = variables[name];
      return {name, raw, coerced: coerceValue(raw), missing: false};
    },
  };
}

function renderText(template: string, where: string, resolver: Resolver,
  uses: RenderedRequest['uses']): string {
  return template.replace(TEMPLATE_RE, (match, name: string) => {
    void match;
    const use = resolver.makeUse(name);
    uses.push({where, variable: use});
    return use.coerced;
  });
}

/** Body rendering. If the body is JSON-shaped, a placeholder that occupies a
 * whole value slot (after `:` / `[` / `,`) is substituted natively — numbers,
 * booleans, arrays and objects keep their type. Placeholders inside JSON
 * strings are interpolated as text. If the template is not valid JSON even
 * after marking, the whole body falls back to plain text rendering. */
function tryRenderJsonBody(
  template: string,
  resolver: Resolver,
  uses: RenderedRequest['uses'],
): string | null {
  const bare: VariableUse[] = [];
  // A placeholder fills a whole JSON value when it sits between a value
  // opener ([ , :), optional surrounding quotes, and a value closer (, ] }).
  // Embedded placeholders (e.g. "order-{{id}}") don't match and stay strings.
  const BARE_RE = /([[,:])([ \t\r\n]*)("?)\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}\3([ \t\r\n]*[,}\]])/g;
  const marked = template.replace(
    BARE_RE,
    (_match, lead: string, gapBefore: string, _quote: string, name: string, tail: string) => {
      const id = bare.length;
      bare.push(resolver.makeUse(name));
      // `tail` includes the trailing whitespace plus the closer char (, ] }).
      return `${lead}${gapBefore}"__BARE_${id}__"${tail}`;
    },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(marked);
  } catch {
    return null;
  }
  for (const use of bare) uses.push({where: 'body', variable: use});
  const revive = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const marker = /^__BARE_(\d+)__$/.exec(node);
      if (marker) return bare[Number(marker[1])].missing ? null : bare[Number(marker[1])].raw;
      return node.replace(TEMPLATE_RE, (_m, name: string) => {
        const use = resolver.makeUse(name);
        uses.push({where: 'body', variable: use});
        return use.coerced;
      });
    }
    if (Array.isArray(node)) return node.map(revive);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        const revivedKey = key.replace(TEMPLATE_RE, (_m, name: string) => {
          const use = resolver.makeUse(name);
          uses.push({where: 'body-key', variable: use});
          return use.coerced;
        });
        out[revivedKey] = revive(val);
      }
      return out;
    }
    return node;
  };
  return JSON.stringify(revive(parsed));
}

export function renderRequest(step: ScenarioStep, variables: Record<string, unknown>): RenderedRequest {
  const warnings: string[] = [];
  const uses: RenderedRequest['uses'] = [];
  const resolver = createResolver(variables, warnings);

  const url = renderText(step.url, 'url', resolver, uses);
  const headers = step.headers
    .filter(header => header.name.trim())
    .map(header => ({
      name: header.name,
      value: renderText(header.value, `header:${header.name}`, resolver, uses),
    }));
  const trimmedBody = step.body.trim();
  let body: string;
  if (trimmedBody.startsWith('{') || trimmedBody.startsWith('[')) {
    body = tryRenderJsonBody(step.body, resolver, uses)
      ?? renderText(step.body, 'body', resolver, uses);
  } else {
    body = renderText(step.body, 'body', resolver, uses);
  }
  return {method: step.method, url, headers, body, uses, warnings};
}

// ---------------------------------------------------------------------------
// Conditions (skip)
// ---------------------------------------------------------------------------

export function evalCondition(
  condition: ScenarioStep['condition'],
  variables: Record<string, unknown>,
): {run: boolean; reason?: string} {
  if (!condition || !condition.variable) return {run: true};
  const {variable, op, value = ''} = condition;
  const defined = Object.prototype.hasOwnProperty.call(variables, variable);
  const asText = coerceValue(variables[variable]);
  let result: boolean;
  switch (op) {
    case 'empty':
      // Missing variable counts as empty; that is the documented skip path.
      result = !defined || asText === '';
      break;
    case 'notEmpty':
      result = defined && asText !== '';
      break;
    case 'equals':
      result = defined && asText === value;
      break;
    case 'notEquals':
      result = !(defined && asText === value);
      break;
    default:
      result = true;
  }
  if (result) return {run: true};
  const suffix = op === 'equals' || op === 'notEquals' ? ` ${JSON.stringify(value)}` : '';
  return {run: false, reason: `条件不满足：${variable} ${op}${suffix}（当前值 ${JSON.stringify(asText)}）`};
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  ok: boolean;
  /** On failure the ORIGINAL variables are returned untouched (atomic, no
   * half-updated variables). */
  variables: Record<string, unknown>;
  applied: {name: string; value: unknown; overwrote: boolean; previous?: unknown}[];
  errors: string[];
}

/** Apply all extractors. Duplicate names inside one step follow last-wins in
 * declared order and each overwrite is reported. On ANY failure the whole
 * draft is discarded; the step's terminate/skip policy then decides whether
 * the run continues (continue == skip policy). */
export function applyExtractions(
  step: ScenarioStep,
  response: {status: number; headers: Record<string, string>; body: unknown},
  variables: Record<string, unknown>,
): ExtractionResult {
  void response.status;
  const errors: string[] = [];
  const draft: Record<string, unknown> = {...variables};
  const applied: ExtractionResult['applied'] = [];
  let parsedBody: {ok: true; value: unknown} | {ok: false} | null = null;

  const putDraft = (name: string, value: unknown) => {
    const overwrote = Object.prototype.hasOwnProperty.call(draft, name);
    applied.push(overwrote
      ? {name, value, overwrote: true, previous: draft[name]}
      : {name, value, overwrote: false});
    draft[name] = value;
  };

  for (const extractor of step.extract) {
    if (!extractor.name) {
      errors.push('存在未命名的提取器');
      continue;
    }
    if (extractor.source === 'header') {
      const wanted = extractor.path.trim().toLowerCase();
      const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === wanted);
      if (!wanted || !entry) {
        errors.push(`响应头 ${extractor.path || '（空）'} 不存在（变量 ${extractor.name}）`);
        continue;
      }
      putDraft(extractor.name, entry[1]);
    } else {
      if (parsedBody === null) {
        try {
          parsedBody = {ok: true, value: typeof response.body === 'string' ? JSON.parse(response.body) : response.body};
        } catch {
          parsedBody = {ok: false};
        }
      }
      if (!parsedBody.ok) {
        errors.push(`响应体不是合法 JSON，无法提取变量 ${extractor.name}`);
        continue;
      }
      const hit = evalJsonPath(parsedBody.value, extractor.path);
      if (!hit.found) {
        errors.push(`${hit.error}（变量 ${extractor.name}）`);
        continue;
      }
      // A fanned-out path (via [*]) writes the array of matches; a single
      // match writes the native value (number stays number — not stringified).
      putDraft(extractor.name, hit.values.length === 1 ? hit.values[0] : hit.values);
    }
  }
  if (errors.length) return {ok: false, variables, applied: [], errors};
  return {ok: true, variables: draft, applied, errors: []};
}

// ---------------------------------------------------------------------------
// Edit-time diagnostics
// ---------------------------------------------------------------------------

/** Undefined references, invalid paths/names, duplicate-variable rules.
 * Condition variables intentionally do NOT error when undefined — a missing
 * variable legitimately satisfies `empty` / fails `notEmpty`, enabling skip. */
export function analyzeDoc(doc: ScenarioDoc): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const defined = new Set<string>();
  for (const name of Object.keys(doc.initialVariables)) {
    if (!NAME_RE.test(name)) diagnostics.push({severity: 'error', message: `初始变量名非法：${name}`});
    defined.add(name);
  }
  doc.steps.forEach((step, stepIndex) => {
    const tag = `步骤 ${stepIndex + 1}「${step.name}」`;
    if (step.enabled && !step.url.trim()) {
      diagnostics.push({severity: 'error', stepId: step.id, message: `${tag}：URL 为空`});
    }

    // Extractors of THIS step land only after the request, so its own
    // references must resolve against earlier definitions (or initial vars).
    const refs: {where: string; text: string}[] = [
      {where: 'URL', text: step.url},
      ...step.headers.map(h => ({where: `请求头 ${h.name || '（空）'}`, text: h.value})),
      {where: '请求体', text: step.body},
    ];
    for (const {where, text} of refs) {
      for (const match of text.matchAll(new RegExp(TEMPLATE_RE.source, 'g'))) {
        if (!defined.has(match[1])) {
          diagnostics.push({severity: 'error', stepId: step.id,
            message: `${tag}：${where} 引用了未定义变量 {{${match[1]}}}`});
        }
      }
    }
    if (step.condition?.variable && !NAME_RE.test(step.condition.variable)) {
      diagnostics.push({severity: 'error', stepId: step.id, message: `${tag}：条件变量名非法 ${step.condition.variable}`});
    }

    const seenThisStep = new Set<string>();
    step.extract.forEach((extractor, i) => {
      if (!extractor.name) {
        diagnostics.push({severity: 'error', stepId: step.id, message: `${tag}：第 ${i + 1} 个提取器未命名`});
        return;
      }
      if (!NAME_RE.test(extractor.name)) {
        diagnostics.push({severity: 'error', stepId: step.id, message: `${tag}：提取变量名非法 ${extractor.name}`});
      }
      if (seenThisStep.has(extractor.name)) {
        diagnostics.push({severity: 'warning', stepId: step.id,
          message: `${tag}：变量 ${extractor.name} 在本步骤被重复提取，按声明顺序后者覆盖前者（last-wins）`});
      } else if (defined.has(extractor.name)) {
        diagnostics.push({severity: 'info', stepId: step.id,
          message: `${tag}：将覆盖已有变量 ${extractor.name}（同名变量由编号靠后的步骤覆盖）`});
      }
      seenThisStep.add(extractor.name);
      defined.add(extractor.name);
    });

    for (const extractor of step.extract) {
      if (extractor.source === 'json' && extractor.path) {
        const compiled = compileJsonPath(extractor.path);
        if ('error' in compiled) {
          diagnostics.push({severity: 'error', stepId: step.id, message: `${tag}：${compiled.error}`});
        }
      }
    }
    if (!step.enabled) {
      diagnostics.push({severity: 'info', stepId: step.id, message: `${tag}：已禁用，运行时跳过`});
    }
  });
  return diagnostics;
}

export function cloneDoc(doc: ScenarioDoc): ScenarioDoc {
  return JSON.parse(JSON.stringify(doc)) as ScenarioDoc;
}

export function newStep(id: string, index: number): ScenarioStep {
  return {
    id, name: `Step ${index}`, enabled: true, method: 'GET', url: '',
    headers: [], body: '', condition: null, onExtractFailure: 'terminate', extract: [],
  };
}

export function emptyDoc(): ScenarioDoc {
  return {
    kind: 'api-scenario', version: 1,
    initialVariables: {baseUrl: 'https://example.com'},
    steps: [newStep('step-1', 1)],
  };
}

export function stringifyDoc(doc: ScenarioDoc): string {
  return JSON.stringify(doc, null, 2);
}

export type {JsonValue};
