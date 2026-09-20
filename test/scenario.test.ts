import {describe, expect, it} from 'vitest';
import {analyzeScenario, findRefs, parseJsonPath, parseScenario, readJsonPath, renderTemplate, resolveValue} from '../src/shared/scenario';

describe('templating', () => {
  it('finds unique references', () => {
    expect(findRefs('a {{token}} b {{ token }} c {{user_id}} {{token}}')).toEqual(['token', 'user_id']);
    expect(findRefs('no refs')).toEqual([]);
  });
  it('substitutes strings as-is and reports missing references', () => {
    const r = renderTemplate('/users/{{id}}?t={{token}}&x={{nope}}', {id: '7', token: 'abc'});
    expect(r.text).toBe('/users/7?t=abc&x={{nope}}');
    expect(r.missing).toEqual(['nope']);
  });
  it('inserts non-string values as JSON text', () => {
    expect(renderTemplate('{"id": {{num}}, "ok": {{flag}}, "tags": {{list}}, "user": {{obj}}}', {num: 42, flag: true, list: ['a', 'b'], obj: {x: 1}}).text).toBe(
      '{"id": 42, "ok": true, "tags": ["a","b"], "user": {"x":1}}',
    );
  });
  it('resolveValue keeps the raw value for a single-reference template', () => {
    expect(resolveValue('{{flag}}', {flag: true})).toEqual({value: true, missing: []});
    expect(resolveValue('{{num}}', {num: 0})).toEqual({value: 0, missing: []});
    expect(resolveValue('x{{flag}}', {flag: true})).toEqual({value: 'xtrue', missing: []});
    expect(resolveValue('{{gone}}', {}).missing).toEqual(['gone']);
  });
});

describe('json path', () => {
  const data = {user: {id: 42, name: 'ada', tags: ['a', 'b', 'c']}, items: [{id: 1}, {id: 2}], flag: false, nothing: null};
  it('parses dot, index and quoted-key segments', () => {
    expect(parseJsonPath('$.user.tags[2]')).toEqual(['user', 'tags', 2]);
    expect(parseJsonPath('$["user"].items[0].id')).toEqual(['user', 'items', 0, 'id']);
    expect(parseJsonPath('$')).toEqual([]);
    expect(parseJsonPath('user.id')).toBeNull();
    expect(parseJsonPath('$.items[-1]')).toBeNull();
    expect(parseJsonPath('$.items[*]')).toBeNull();
  });
  it('reads nested values including arrays and falsy leaves', () => {
    expect(readJsonPath(data, '$.user.tags[1]').value).toBe('b');
    expect(readJsonPath(data, '$.items[0]')).toEqual({ok: true, value: {id: 1}});
    expect(readJsonPath(data, '$.items').value).toEqual([{id: 1}, {id: 2}]);
    expect(readJsonPath(data, '$.flag')).toEqual({ok: true, value: false});
    expect(readJsonPath(data, '$.nothing')).toEqual({ok: true, value: null});
    expect(readJsonPath(data, '$').value).toEqual(data);
  });
  it('fails cleanly on missing segments', () => {
    expect(readJsonPath(data, '$.user.missing').ok).toBe(false);
    expect(readJsonPath(data, '$.items[9]').ok).toBe(false);
    expect(readJsonPath(data, '$.user.id.deeper').ok).toBe(false);
    expect(readJsonPath(data, '$.items.id').ok).toBe(false); // property on an array
    expect(readJsonPath(null, '$.a').ok).toBe(false);
  });
});

describe('parseScenario', () => {
  it('normalizes defaults', () => {
    const {def, error} = parseScenario(JSON.stringify({steps: [{url: 'http://x/'}]}));
    expect(error).toBeUndefined();
    expect(def!.steps[0]).toMatchObject({id: 'step1', method: 'GET', onExtractError: 'abort', extract: [], headers: {}});
  });
  it('rejects malformed definitions with useful messages', () => {
    expect(parseScenario('not json').error).toMatch(/not valid JSON/);
    expect(parseScenario('{"steps": {}}').error).toMatch(/steps/);
    expect(parseScenario('{"steps": [{"id": "a"}]}').error).toMatch(/url/);
    expect(parseScenario('{"steps": [{"url": "http://x", "onExtractError": "maybe"}]}').error).toMatch(/onExtractError/);
    expect(parseScenario('{"steps": [{"url": "http://x", "extract": [{"name": "t", "from": "cookie", "key": "x"}]}]}').error).toMatch(/from/);
  });
});

describe('analyzeScenario', () => {
  it('flags references to variables no earlier step defines', () => {
    const def = parseScenario(
      JSON.stringify({
        steps: [
          {id: 'login', url: 'http://x/login', extract: [{name: 'token', from: 'json', key: '$.token'}]},
          {id: 'me', url: 'http://x/me?t={{token}}&u={{user}}', headers: {'x-self': '{{token}}'}},
        ],
      }),
    ).def!;
    const diags = analyzeScenario(def);
    expect(diags.filter(d => d.level === 'error')).toHaveLength(1);
    expect(diags[0]).toMatchObject({step: 'me', level: 'error'});
    expect(diags[0].message).toContain('"user"');
  });
  it('a step cannot use variables it extracts itself', () => {
    const def = parseScenario(JSON.stringify({steps: [{id: 'a', url: 'http://x/{{token}}', extract: [{name: 'token', from: 'json', key: '$.t'}]}]})).def!;
    expect(analyzeScenario(def).some(d => d.level === 'error' && d.message.includes('"token"'))).toBe(true);
  });
  it('warns on duplicate extractions and cross-step overwrites', () => {
    const def = parseScenario(
      JSON.stringify({
        steps: [
          {id: 'a', url: 'http://x/', extract: [{name: 'v', from: 'json', key: '$.a'}, {name: 'v', from: 'json', key: '$.b'}]},
          {id: 'b', url: 'http://x/', extract: [{name: 'v', from: 'json', key: '$.c'}]},
        ],
      }),
    ).def!;
    const warnings = analyzeScenario(def).filter(d => d.level === 'warning');
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toMatch(/duplicate extraction "v"/);
    expect(warnings[1].message).toMatch(/overwrites/);
  });
  it('flags invalid json paths and empty urls', () => {
    const def = parseScenario(JSON.stringify({steps: [{id: 'a', url: ' ', extract: [{name: 'v', from: 'json', key: 'a.b'}]}]})).def!;
    const errors = analyzeScenario(def).filter(d => d.level === 'error');
    expect(errors.some(d => d.message.includes('url is empty'))).toBe(true);
    expect(errors.some(d => d.message.includes('invalid JSON path'))).toBe(true);
  });
});
