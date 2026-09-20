import {randomUUID} from 'node:crypto';
import type {RunRecord, ScenarioDoc, ScenarioStep, StepRunRecord} from '../shared/types';
import {
  applyExtractions, evalCondition, renderRequest,
} from '../shared/scenario';
export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  send(request: {method: string; url: string; headers: {name: string; value: string}[]; body: string},
    signal: AbortSignal): Promise<TransportResponse>;
}

const BODY_PREVIEW_LIMIT = 20_000;

function snapshot(variables: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(variables)) as Record<string, unknown>;
}

function preview(body: string): string {
  return body.length > BODY_PREVIEW_LIMIT
    ? `${body.slice(0, BODY_PREVIEW_LIMIT)}\n…（已截断，共 ${body.length} 字符）`
    : body;
}

export interface StoredRun extends RunRecord {
  cancelRequested: boolean;
  currentAbort: AbortController | null;
}

export class RunStore {
  private readonly runs = new Map<string, StoredRun>();

  start(scenarioId: string, revision: number, doc: ScenarioDoc): StoredRun {
    const now = new Date().toISOString();
    const run: StoredRun = {
      id: randomUUID(),
      scenarioId,
      revision,
      status: 'running',
      steps: [],
      plan: doc.steps.map(step => ({stepId: step.id, name: step.name})),
      cancelRequested: false,
      currentAbort: null,
      createdAt: now,
    };
    this.runs.set(run.id, run);
    return run;
  }

  get(id: string): StoredRun | undefined {
    return this.runs.get(id);
  }

  list(scenarioId: string): RunRecord[] {
    return [...this.runs.values()]
      .filter(run => run.scenarioId === scenarioId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(run => this.publicView(run));
  }

  /** Strip in-flight-only fields. */
  publicView(run: StoredRun): RunRecord {
    const {cancelRequested: _c, currentAbort: _a, ...publicRun} = run;
    void _c; void _a;
    return JSON.parse(JSON.stringify(publicRun)) as RunRecord;
  }
}

/**
 * Request cancellation. The cancel route only flips `cancelRequested` and
 * aborts the in-flight HTTP call; it NEVER writes a terminal status. The
 * runner is the sole writer of terminal states. Every terminal transition goes
 * through the synchronous `finish` guard below, so cancellation racing with
 * the last step's completion can produce exactly one terminal state.
 */
export async function executeRun(
  run: StoredRun,
  doc: ScenarioDoc,
  transport: Transport,
): Promise<void> {
  const variables: Record<string, unknown> = {...doc.initialVariables};
  let finished = false;

  const finish = (status: Extract<RunRecord['status'], 'completed' | 'failed' | 'cancelled'>,
    failure?: RunRecord['failure']): boolean => {
    if (finished) return false;
    finished = true;
    run.status = status;
    run.endedAt = new Date().toISOString();
    if (failure) run.failure = failure;
    return true;
  };

  for (let index = 0; index < doc.steps.length; index += 1) {
    // Cancellation check before starting the step.
    if (run.cancelRequested) {
      finish('cancelled');
      return;
    }
    const step = doc.steps[index];
    const variablesBefore = snapshot(variables);
    const startedAt = new Date().toISOString();

    // Disabled steps and unmet conditions are recorded as skipped — they are
    // part of the run's history, with untouched variable snapshots.
    if (!step.enabled) {
      run.steps.push(skippedRecord(index, step, variablesBefore, startedAt, '步骤已禁用'));
      continue;
    }
    const condition = evalCondition(step.condition, variables);
    if (!condition.run) {
      run.steps.push(skippedRecord(index, step, variablesBefore, startedAt, condition.reason ?? '条件不满足'));
      continue;
    }

    const rendered = renderRequest(step, variables);
    const controller = new AbortController();
    run.currentAbort = controller;
    let response: TransportResponse;
    try {
      response = await transport.send(
        {method: rendered.method, url: rendered.url, headers: rendered.headers, body: rendered.body},
        controller.signal,
      );
    } catch (error) {
      const cancelled = run.cancelRequested || controller.signal.aborted;
      const record: StepRunRecord = {
        index, stepId: step.id, name: step.name,
        status: cancelled ? 'cancelled' : 'failed',
        reason: cancelled ? '运行已取消，请求被中止' : (error instanceof Error ? error.message : String(error)),
        request: rendered,
        variablesBefore,
        variablesAfter: snapshot(variables),
        startedAt, endedAt: new Date().toISOString(),
      };
      run.steps.push(record);
      run.currentAbort = null;
      if (cancelled) {
        finish('cancelled');
      } else {
        finish('failed', {stepId: step.id, message: record.reason!});
      }
      return;
    }
    run.currentAbort = null;
    const endedAt = new Date().toISOString();

    // Cancel arriving while the response was in flight: do not extract and do
    // not mutate variables; the terminal state is cancelled.
    if (run.cancelRequested) {
      run.steps.push({
        index, stepId: step.id, name: step.name, status: 'cancelled',
        reason: '响应到达后检测到取消，本步骤的提取结果已丢弃',
        request: rendered,
        response: {status: response.status, headers: response.headers, bodyPreview: preview(response.body)},
        variablesBefore, variablesAfter: snapshot(variables),
        startedAt, endedAt: new Date().toISOString(),
      });
      finish('cancelled');
      return;
    }

    const extraction = applyExtractions(step, {
      status: response.status, headers: response.headers, body: response.body,
    }, variables);

    if (!extraction.ok) {
      const message = `变量提取失败：${extraction.errors.join('；')}`;
      run.steps.push({
        index, stepId: step.id, name: step.name,
        status: 'failed', reason: message,
        request: rendered,
        response: {status: response.status, headers: response.headers, bodyPreview: preview(response.body)},
        // Variables are unchanged — failed extraction is atomic.
        variablesBefore, variablesAfter: snapshot(variables),
        startedAt, endedAt,
      });
      if (step.onExtractFailure === 'terminate') {
        finish('failed', {stepId: step.id, message});
        return;
      }
      // skip policy: record the failure on the step but continue the run. The
      // step stays 'failed' (visible), variables untouched.
      continue;
    }

    // Commit extraction wholesale (applyExtractions already returned the
    // complete next snapshot or none at all).
    for (const [key, value] of Object.entries(extraction.variables)) variables[key] = value;
    run.steps.push({
      index, stepId: step.id, name: step.name, status: 'completed',
      request: rendered,
      response: {status: response.status, headers: response.headers, bodyPreview: preview(response.body)},
      variablesBefore, variablesAfter: snapshot(variables),
      extracted: extraction.applied,
      startedAt, endedAt,
    });
  }

  // Last step completed vs. cancel race: even if cancelRequested is set here,
  // every step already finished normally (cancel landed after the last check),
  // so the single terminal state is 'completed'. The guard makes this decision
  // exactly once.
  finish('completed');
}

function skippedRecord(index: number, step: ScenarioStep, variablesBefore: Record<string, unknown>,
  startedAt: string, reason: string): StepRunRecord {
  return {
    index, stepId: step.id, name: step.name, status: 'skipped', reason,
    variablesBefore, variablesAfter: JSON.parse(JSON.stringify(variablesBefore)),
    startedAt, endedAt: new Date().toISOString(),
  };
}
