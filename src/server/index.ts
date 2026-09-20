import express from 'express';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {
  analyzeScenario,
  parseScenario,
  readJsonPath,
  renderTemplate,
  resolveValue,
  type Diagnostic,
  type ExtractionResult,
  type RunRecord,
  type RunStatus,
  type RunSummary,
  type StepDef,
} from '../shared/scenario';

type RecordRow = {id: string; name: string; revision: number; content: string; updatedAt: string};
const rows: RecordRow[] = [
  {
    id: 'alpha',
    name: 'Primary request sequences',
    revision: 3,
    content: JSON.stringify(
      {
        steps: [
          {
            id: 'bootstrap',
            method: 'GET',
            url: 'http://127.0.0.1:4174/api/bootstrap',
            extract: [{name: 'family', from: 'json', key: '$.family'}],
          },
          {
            id: 'list',
            method: 'GET',
            url: 'http://127.0.0.1:4174/api/scenarios',
            headers: {'x-scenario-family': '{{family}}'},
          },
        ],
      },
      null,
      2,
    ),
    updatedAt: new Date(0).toISOString(),
  },
  {id: 'beta', name: 'Secondary request sequences', revision: 5, content: 'request sequences: beta\nstate: review', updatedAt: new Date(1000).toISOString()},
];

// Runs live only on the server, so a page refresh can re-fetch them.
const runs = new Map<string, RunRecord>();
const runControllers = new Map<string, AbortController>();
const MAX_BODY_CHARS = 8192;

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clampInt = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

// Single guarded transition into a terminal state: whichever path (executor
// completion, step failure, cancel) gets here first wins; later attempts are
// rejected so a run can never end up with two terminal states.
export function finishRun(run: RunRecord, status: RunStatus): boolean {
  if (run.status !== 'running') return false;
  run.status = status;
  run.finishedAt = now();
  return true;
}

function summarize(run: RunRecord): RunSummary {
  return {
    id: run.id,
    scenarioId: run.scenarioId,
    revision: run.revision,
    status: run.status,
    steps: run.steps.length,
    finishedSteps: run.steps.filter(s => s.status !== 'pending' && s.status !== 'running').length,
    createdAt: run.createdAt,
    ...(run.finishedAt ? {finishedAt: run.finishedAt} : {}),
  };
}

// Computes a step's extractions against the response. Nothing is applied here;
// the caller applies the whole batch only when every extraction succeeded.
function computeExtractions(def: StepDef, resHeaders: Headers, bodyText: string): ExtractionResult[] {
  const results: ExtractionResult[] = [];
  let json: unknown;
  let jsonParsed = false;
  let jsonError: string | null = null;
  for (const ex of def.extract) {
    if (ex.from === 'header') {
      const value = resHeaders.get(ex.key);
      if (value === null) results.push({name: ex.name, ok: false, error: `header "${ex.key}" not found`});
      else results.push({name: ex.name, ok: true, value});
    } else {
      if (!jsonParsed) {
        jsonParsed = true;
        try {
          json = JSON.parse(bodyText);
        } catch {
          jsonError = 'response body is not valid JSON';
        }
      }
      if (jsonError !== null) {
        results.push({name: ex.name, ok: false, error: jsonError});
        continue;
      }
      const r = readJsonPath(json, ex.key);
      if (r.ok) results.push({name: ex.name, ok: true, value: r.value});
      else results.push({name: ex.name, ok: false, error: r.error ?? 'path not found'});
    }
  }
  return results;
}

async function executeRun(run: RunRecord): Promise<void> {
  for (let i = 0; i < run.definition.steps.length; i++) {
    if (run.status !== 'running') return; // cancelled between steps
    const def = run.definition.steps[i];
    const rec = run.steps[i];
    rec.startedAt = now();

    // Render every template up front; any undefined reference fails the step
    // before anything is sent.
    const missing = new Set<string>();
    const skip = def.skipIf !== undefined ? resolveValue(def.skipIf, run.variables) : {value: false, missing: [] as string[]};
    skip.missing.forEach(m => missing.add(m));
    const url = renderTemplate(def.url, run.variables);
    url.missing.forEach(m => missing.add(m));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(def.headers)) {
      const r = renderTemplate(v, run.variables);
      r.missing.forEach(m => missing.add(m));
      headers[k] = r.text;
    }
    let body: string | undefined;
    if (def.body !== undefined && def.body !== '') {
      const r = renderTemplate(def.body, run.variables);
      r.missing.forEach(m => missing.add(m));
      body = r.text;
    }
    if (missing.size > 0) {
      rec.status = 'failed';
      rec.error = `undefined variable(s): ${[...missing].join(', ')}`;
      rec.variablesAfter = {...run.variables};
      rec.finishedAt = now();
      finishRun(run, 'failed');
      return;
    }
    if (skip.value === true || skip.value === 'true') {
      rec.status = 'skipped';
      rec.variablesAfter = {...run.variables};
      rec.finishedAt = now();
      continue;
    }

    rec.request = {method: def.method, url: url.text, headers, ...(body !== undefined ? {body} : {})};
    rec.status = 'running';
    const controller = new AbortController();
    runControllers.set(run.id, controller);
    const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${run.timeoutMs}ms`)), run.timeoutMs);
    try {
      const res = await fetch(url.text, {method: def.method, headers, ...(body !== undefined && def.method !== 'GET' && def.method !== 'HEAD' ? {body} : {}), signal: controller.signal});
      const text = (await res.text()).slice(0, MAX_BODY_CHARS);
      rec.response = {status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text};
      const results = computeExtractions(def, res.headers, text);
      rec.extractions = results;
      const failed = results.filter(r => !r.ok);
      if (failed.length === 0) {
        // Atomic batch: applied in extraction order, so a duplicate name inside
        // the step resolves to the last extraction.
        for (const r of results) run.variables[r.name] = r.value;
        rec.status = 'success';
      } else if (def.onExtractError === 'abort') {
        rec.status = 'failed';
        rec.error = 'extraction failed: ' + failed.map(f => `${f.name} (${f.error})`).join('; ');
        rec.variablesAfter = {...run.variables};
        rec.finishedAt = now();
        finishRun(run, 'failed');
        return;
      } else {
        // onExtractError "skip": apply nothing from this step, keep going.
        rec.status = 'success';
        rec.error = 'extraction skipped: ' + failed.map(f => `${f.name} (${f.error})`).join('; ');
      }
      rec.variablesAfter = {...run.variables};
    } catch (err) {
      if (run.status !== 'running') {
        rec.status = 'cancelled'; // cancel aborted the in-flight request
        rec.finishedAt = now();
        return;
      }
      rec.status = 'failed';
      rec.error = err instanceof Error ? err.message : String(err);
      rec.variablesAfter = {...run.variables};
      rec.finishedAt = now();
      finishRun(run, 'failed');
      return;
    } finally {
      clearTimeout(timer);
      runControllers.delete(run.id);
      if (!rec.finishedAt) rec.finishedAt = now();
    }
    if (run.stepDelayMs > 0 && i < run.definition.steps.length - 1) await sleep(run.stepDelayMs);
  }
  finishRun(run, 'completed');
}

export function createApp() {
  const app = express();
  app.use(express.json({limit: '1mb'}));

  app.get('/api/bootstrap', (_req, res) => res.json({family: 'api-scenario', count: rows.length}));
  app.get('/api/scenarios', (_req, res) => res.json(rows.map(({content, ...row}) => row)));
  app.get('/api/scenarios/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.set('ETag', String(row.revision)).json(row);
  });
  app.put('/api/scenarios/:id', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    if (req.body.revision !== row.revision) return res.status(409).json({error: 'revision_conflict', current: row});
    row.content = String(req.body.content ?? '');
    row.revision += 1;
    row.updatedAt = now();
    res.json(row);
  });
  app.post('/api/scenarios/:id/analyze', async (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    await sleep(req.params.id === 'alpha' ? 100 : 20);
    const content = String(req.body.content ?? row.content);
    const parsed = parseScenario(content);
    const diagnostics: Diagnostic[] = parsed.def ? analyzeScenario(parsed.def) : [{level: 'error', message: parsed.error ?? 'invalid scenario'}];
    res.json({id: row.id, revision: row.revision, lines: content.split(/\r?\n/).length, diagnostics});
  });

  // Start a run pinned to the scenario's current revision: the definition is
  // snapshotted now, so edits during execution never affect this run.
  app.post('/api/scenarios/:id/runs', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    const body = req.body ?? {};
    if (body.expectedRevision !== undefined && body.expectedRevision !== row.revision) {
      return res.status(409).json({error: 'revision_conflict', current: row.revision});
    }
    const parsed = parseScenario(row.content);
    if (!parsed.def) return res.status(422).json({error: 'invalid_scenario', details: parsed.error});
    const run: RunRecord = {
      id: randomUUID(),
      scenarioId: row.id,
      revision: row.revision,
      status: 'running',
      definition: parsed.def,
      variables: {},
      steps: parsed.def.steps.map((s, index) => ({stepId: s.id, index, status: 'pending'})),
      stepDelayMs: clampInt(body.delayMs, 0, 5000, 0),
      timeoutMs: clampInt(body.timeoutMs, 1, 30000, 10000),
      createdAt: now(),
    };
    runs.set(run.id, run);
    void executeRun(run);
    res.status(201).json(run);
  });
  app.get('/api/scenarios/:id/runs', (req, res) => {
    const row = rows.find(value => value.id === req.params.id);
    if (!row) return res.status(404).json({error: 'not_found'});
    res.json([...runs.values()].filter(r => r.scenarioId === row.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarize));
  });
  app.get('/api/runs/:runId', (req, res) => {
    const run = runs.get(req.params.runId);
    if (!run) return res.status(404).json({error: 'not_found'});
    res.json(run);
  });
  app.post('/api/runs/:runId/cancel', (req, res) => {
    const run = runs.get(req.params.runId);
    if (!run) return res.status(404).json({error: 'not_found'});
    if (!finishRun(run, 'cancelled')) return res.status(409).json({error: 'already_finished', status: run.status, run});
    runControllers.get(run.id)?.abort(new Error('run cancelled'));
    for (const step of run.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        step.status = 'cancelled';
        step.finishedAt = step.finishedAt ?? now();
      }
    }
    res.json(run);
  });
  return app;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(4174, '127.0.0.1', () => console.log('server http://127.0.0.1:4174'));
}
