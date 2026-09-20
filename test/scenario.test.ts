import {describe, expect, it} from 'vitest';
import {
  analyzeDoc, applyExtractions, coerceValue, evalCondition, evalJsonPath,
  parseScenario, renderRequest, stringifyDoc, newStep,
} from '../src/shared/scenario';
import type {ScenarioDoc, ScenarioStep} from '../src/shared/types';

function step(partial: Partial<ScenarioStep> = {}): ScenarioStep {
  return {
    ...newStep('s1', 1),
    ...partial,
  };
}

function doc(steps: ScenarioStep[], initialVariables: Record<string, string> = {}): ScenarioDoc {
  return {kind: 'api-scenario', version: 1, initialVariables, steps};
}

describe('json path', () => {
  it('reads root, dotted fields, bracket keys, numeric indices and wildcards', () => {
    const data = {items: [{id: 1}, {id: 2}], meta: {'x y': 3}};
    const hits = (path: string) => {
      const result = evalJsonPath(data, path);
      if (!result.found) throw new Error(`path failed: ${path} (${result.error})`);
      return result.values;
    };
    expect(hits('$')).toEqual([data]);
    expect(hits('$.items[0].id')).toEqual([1]);
    expect(hits('$.items[*].id')).toEqual([1, 2]);
    expect(hits('$.meta["x y"]')).toEqual([3]);
    const arrayHits = evalJsonPath([10, 20], '[1]');
    expect(arrayHits.found && arrayHits.values).toEqual([20]);
    const emptyHits = evalJsonPath({a: []}, '$.a[*]');
    expect(emptyHits.found && emptyHits.values).toEqual([]);
  });

  it('treats missing fields, out-of-range indices and wildcard on non-array as failures', () => {
    expect(evalJsonPath({a: 1}, '$.a[*]').found).toBe(false);
    expect(evalJsonPath({items: [1]}, '$.items[3]').found).toBe(false);
    expect(evalJsonPath({a: {}}, '$.a.b').found).toBe(false);
    expect(evalJsonPath({}, '[0]').found).toBe(false);
  });

  it('rejects malformed paths at edit time', () => {
    expect(evalJsonPath({}, 'items[0]').found).toBe(false);
    expect(evalJsonPath({}, '$.a.').found).toBe(false);
    expect(evalJsonPath({}, '$.a[0').found).toBe(false);
    expect(evalJsonPath({}, '$.a[=]').found).toBe(false);
  });
});

describe('templating and non-string values', () => {
  it('substitutes into url and headers with uniform string coercion', () => {
    const s = step({url: '/u/{{id}}', headers: [{name: 'x', value: 'v={{id}}'}]});
    const rendered = renderRequest(s, {id: 42});
    expect(rendered.url).toBe('/u/42');
    expect(rendered.headers[0].value).toBe('v=42');
    expect(rendered.uses[0].variable.raw).toBe(42);
  });

  it('preserves native types when a placeholder fills a whole JSON body value', () => {
    const s = step({body: JSON.stringify({id: '{{id}}', active: '{{flag}}', tags: '{{tags}}', nested: {n: '{{n}}'}})});
    const rendered = renderRequest(s, {id: 7, flag: true, tags: [1, 2], n: null});
    const parsed = JSON.parse(rendered.body);
    expect(parsed).toEqual({id: 7, active: true, tags: [1, 2], nested: {n: null}});
  });

  it('keeps placeholders inside JSON strings as strings, even with numeric values', () => {
    const s = step({body: JSON.stringify({ref: 'order-{{id}}'})});
    const rendered = renderRequest(s, {id: 5});
    expect(JSON.parse(rendered.body).ref).toBe('order-5');
  });

  it('renders arrays and objects as JSON text in URLs/headers', () => {
    expect(coerceValue({a: 1})).toBe('{"a":1}');
    expect(coerceValue([1, 2])).toBe('[1,2]');
    expect(coerceValue(null)).toBe('');
    expect(coerceValue(undefined)).toBe('');
  });

  it('records missing references with missing=true and empty substitution plus a warning', () => {
    const s = step({url: '/u/{{ghost}}'});
    const rendered = renderRequest(s, {});
    expect(rendered.url).toBe('/u/');
    expect(rendered.uses[0].variable.missing).toBe(true);
    expect(rendered.warnings[0]).toContain('ghost');
  });

  it('falls back to plain-text rendering for non-JSON bodies', () => {
    const s = step({body: 'raw {{id}} tail'});
    expect(renderRequest(s, {id: 1}).body).toBe('raw 1 tail');
  });
});

describe('conditions', () => {
  it('supports empty / notEmpty / equals / notEquals, missing counts as empty', () => {
    expect(evalCondition({variable: 'x', op: 'empty'}, {}).run).toBe(true);
    expect(evalCondition({variable: 'x', op: 'empty'}, {x: ''}).run).toBe(true);
    expect(evalCondition({variable: 'x', op: 'empty'}, {x: 'a'}).run).toBe(false);
    expect(evalCondition({variable: 'x', op: 'notEmpty'}, {}).run).toBe(false);
    expect(evalCondition({variable: 'x', op: 'equals', value: '42'}, {x: 42}).run).toBe(true);
    expect(evalCondition({variable: 'x', op: 'notEquals', value: 'a'}, {x: 'b'}).run).toBe(true);
    expect(evalCondition(null, {}).run).toBe(true);
  });
});

describe('extraction', () => {
  const response = {
    status: 200,
    headers: {'x-trace-id': 'T-1'},
    body: JSON.stringify({token: 'tok', items: [{id: 1}, {id: 2}], count: 3}),
  };

  it('extracts headers and json paths; wildcard writes the array of matches', () => {
    const s = step({extract: [
      {name: 'trace', source: 'header', path: 'X-Trace-Id'},
      {name: 'token', source: 'json', path: '$.token'},
      {name: 'ids', source: 'json', path: '$.items[*].id'},
      {name: 'count', source: 'json', path: '$.count'},
    ]});
    const result = applyExtractions(s, response, {});
    expect(result.ok).toBe(true);
    expect(result.variables).toMatchObject({trace: 'T-1', token: 'tok', ids: [1, 2], count: 3});
  });

  it('keeps numeric extracted values as numbers (not coerced to strings)', () => {
    const s = step({extract: [{name: 'count', source: 'json', path: '$.count'}]});
    const result = applyExtractions(s, response, {});
    expect(typeof result.variables.count).toBe('number');
  });

  it('duplicate names within one step: last-wins in declared order, overwrites marked', () => {
    const s = step({extract: [
      {name: 'token', source: 'json', path: '$.token'},
      {name: 'token', source: 'header', path: 'x-trace-id'},
    ]});
    const result = applyExtractions(s, response, {});
    expect(result.ok).toBe(true);
    expect(result.variables.token).toBe('T-1');
    expect(result.applied[0]).toMatchObject({name: 'token', value: 'tok', overwrote: false});
    expect(result.applied[1]).toMatchObject({name: 'token', value: 'T-1', overwrote: true, previous: 'tok'});
  });

  it('overwriting an earlier variable records the previous value', () => {
    const s = step({extract: [{name: 'token', source: 'header', path: 'x-trace-id'}]});
    const result = applyExtractions(s, response, {token: 'old'});
    expect(result.applied[0]).toEqual({name: 'token', value: 'T-1', overwrote: true, previous: 'old'});
  });

  it('any failed extractor discards the whole draft (no half-updated variables)', () => {
    const s = step({extract: [
      {name: 'trace', source: 'header', path: 'x-trace-id'},
      {name: 'missing', source: 'header', path: 'x-nope'},
    ]});
    const result = applyExtractions(s, response, {kept: 1});
    expect(result.ok).toBe(false);
    expect(result.variables).toEqual({kept: 1});
    expect(result.applied).toEqual([]);
    expect(result.errors.some(e => e.includes('x-nope'))).toBe(true);
  });

  it('json extraction failure on non-json body is atomic too', () => {
    const s = step({extract: [
      {name: 'a', source: 'json', path: '$.a'},
      {name: 'b', source: 'json', path: '$.b'},
    ]});
    const result = applyExtractions(s, {status: 200, headers: {}, body: 'not json'}, {});
    expect(result.ok).toBe(false);
    expect(result.variables).toEqual({});
  });
});

describe('edit-time diagnostics', () => {
  it('flags undefined references but not condition variables (skip relies on missing)', () => {
    const d = doc([
      step({id: 'a', url: '/a', extract: [{name: 't', source: 'header', path: 'x'}]}),
      step({id: 'b', url: '/b/{{t}}/{{nope}}',
        condition: {variable: 'maybeMissing', op: 'notEmpty'}}),
    ]);
    const messages = analyzeDoc(d).map(x => x.message);
    expect(messages.some(m => m.includes('nope') && m.includes('未定义'))).toBe(true);
    expect(messages.some(m => m.includes('maybeMissing'))).toBe(false);
  });

  it('a step cannot reference a variable it extracts itself in its own request', () => {
    const d = doc([step({url: '/{{t}}', extract: [{name: 't', source: 'header', path: 'x'}]})]);
    expect(analyzeDoc(d).some(x => x.severity === 'error' && x.message.includes('{{t}}'))).toBe(true);
  });

  it('warns on same-step duplicate extraction and infos on cross-step overwrite', () => {
    const d = doc([
      step({id: 'a', url: '/a', extract: [
        {name: 't', source: 'header', path: 'x'},
        {name: 't', source: 'header', path: 'x'},
      ]}),
      step({id: 'b', url: '/b', extract: [{name: 't', source: 'header', path: 'x'}]}),
    ]);
    const diag = analyzeDoc(d);
    expect(diag.some(x => x.severity === 'warning' && x.message.includes('重复提取'))).toBe(true);
    expect(diag.some(x => x.severity === 'info' && x.message.includes('覆盖已有变量'))).toBe(true);
  });

  it('reorders correctly: moving an extractor step earlier makes later refs undefined', () => {
    const producer = step({id: 'p', url: '/p', extract: [{name: 't', source: 'header', path: 'x'}]});
    const consumer = step({id: 'c', url: '/{{t}}'});
    expect(analyzeDoc(doc([producer, consumer])).filter(x => x.severity === 'error')).toHaveLength(0);
    expect(analyzeDoc(doc([consumer, producer]))).toHaveLength(1);
  });

  it('flags invalid json paths in extractors', () => {
    const d = doc([step({url: '/a', extract: [{name: 't', source: 'json', path: 'broken[0]'}]})]);
    expect(analyzeDoc(d).some(x => x.severity === 'error' && x.message.includes('JSON 路径'))).toBe(true);
  });
});

describe('parse', () => {
  it('parses and normalizes scenario json', () => {
    const d = doc([step({url: '/a'})], {k: 'v'});
    const parsed = parseScenario(stringifyDoc(d));
    expect(parsed.doc?.kind).toBe('api-scenario');
    expect(parsed.doc?.initialVariables.k).toBe('v');
    expect(parsed.doc?.steps[0].onExtractFailure).toBe('terminate');
  });

  it('treats legacy free text as non-scenario without throwing', () => {
    const parsed = parseScenario('request sequences: beta\nstate: review');
    expect(parsed.doc).toBeNull();
    expect(parsed.diagnostics[0].severity).toBe('info');
  });
});
