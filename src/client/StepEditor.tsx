import type {Diagnostic, ScenarioDoc, ScenarioStep} from '../shared/types';
import {
  ArrowDown, ArrowUp, Plus, Trash2, Variable,
} from 'lucide-react';

interface Props {
  doc: ScenarioDoc;
  diagnostics: Diagnostic[];
  previewStepId: string | null;
  onChange: (doc: ScenarioDoc) => void;
  onPreview: (stepId: string) => void;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const OPS: {value: NonNullable<ScenarioStep['condition']>['op']; label: string}[] = [
  {value: 'notEmpty', label: '变量非空时执行'},
  {value: 'empty', label: '变量为空时执行'},
  {value: 'equals', label: '等于时执行'},
  {value: 'notEquals', label: '不等于时执行'},
];

export function StepEditor({doc, diagnostics, previewStepId, onChange, onPreview}: Props) {
  const update = (index: number, patch: Partial<ScenarioStep>) => {
    const steps = doc.steps.map((step, i) => i === index ? {...step, ...patch} : step);
    onChange({...doc, steps});
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= doc.steps.length) return;
    const steps = doc.steps.slice();
    [steps[index], steps[target]] = [steps[target], steps[index]];
    onChange({...doc, steps});
  };

  const add = () => {
    const id = `step-${Date.now().toString(36)}-${doc.steps.length + 1}`;
    const step: ScenarioStep = {
      id, name: `Step ${doc.steps.length + 1}`, enabled: true, method: 'GET', url: '',
      headers: [], body: '', condition: null, onExtractFailure: 'terminate', extract: [],
    };
    onChange({...doc, steps: [...doc.steps, step]});
  };

  const remove = (index: number) => {
    onChange({...doc, steps: doc.steps.filter((_, i) => i !== index)});
  };

  return (
    <div className="steps">
      {doc.steps.map((step, index) => {
        const stepDiags = diagnostics.filter(d => d.stepId === step.id);
        const errors = stepDiags.filter(d => d.severity === 'error').length;
        return (
          <section className={`step-card ${step.enabled ? '' : 'disabled'} ${errors ? 'has-error' : ''}`} key={step.id}>
            <header className="step-head">
              <input
                className="step-name"
                value={step.name}
                aria-label={`步骤 ${index + 1} 名称`}
                onChange={e => update(index, {name: e.target.value})}
              />
              <span className="step-index">#{index + 1}</span>
              <div className="step-actions">
                <button type="button" title="上移" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14}/></button>
                <button type="button" title="下移" disabled={index === doc.steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14}/></button>
                <button type="button" title="预览此步骤（用当前变量解析）" onClick={() => onPreview(step.id)}><Variable size={14}/></button>
                <button type="button" className="danger" title="删除步骤" onClick={() => remove(index)}><Trash2 size={14}/></button>
              </div>
            </header>

            <label className="step-toggle">
              <input type="checkbox" checked={step.enabled} onChange={e => update(index, {enabled: e.target.checked})}/>
              启用
            </label>

            <div className="row">
              <select aria-label="HTTP 方法" value={step.method} onChange={e => update(index, {method: e.target.value})}>
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input className="grow" aria-label="URL" placeholder="/path/{{id}} 或 https://…"
                value={step.url} onChange={e => update(index, {url: e.target.value})}/>
            </div>

            <HeadersEditor step={step} onPatch={patch => update(index, patch)}/>

            <textarea className="body-input" aria-label="请求体" rows={3}
              placeholder='请求体，JSON 可写 {"id": "{{id}}"}（值位置保留原生类型）'
              value={step.body} onChange={e => update(index, {body: e.target.value})}/>

            <ConditionEditor step={step} onPatch={patch => update(index, patch)}/>
            <ExtractorsEditor step={step} onPatch={patch => update(index, patch)}/>

            <div className="row policy-row">
              <label>提取失败时：</label>
              <label><input type="radio" name={`policy-${step.id}`} checked={step.onExtractFailure === 'terminate'}
                onChange={() => update(index, {onExtractFailure: 'terminate'})}/>终止场景</label>
              <label><input type="radio" name={`policy-${step.id}`} checked={step.onExtractFailure === 'skip'}
                onChange={() => update(index, {onExtractFailure: 'skip'})}/>跳过提取继续</label>
              {previewStepId === step.id && <span className="pill ok">预览已生成 →</span>}
            </div>

            {stepDiags.map((d, i) => (
              <div className={`diag-line ${d.severity}`} key={i}>{d.message}</div>
            ))}
          </section>
        );
      })}
      <button type="button" className="add-step" onClick={add}><Plus size={15}/>添加步骤</button>
    </div>
  );
}

function HeadersEditor({step, onPatch}: {step: ScenarioStep; onPatch: (patch: Partial<ScenarioStep>) => void}) {
  const set = (i: number, patch: Partial<{name: string; value: string}>) => {
    const headers = step.headers.map((h, j) => j === i ? {...h, ...patch} : h);
    onPatch({headers});
  };
  return (
    <div className="kv-block">
      {step.headers.map((header, i) => (
        <div className="row" key={i}>
          <input placeholder="头名称" value={header.name} onChange={e => set(i, {name: e.target.value})}/>
          <input className="grow" placeholder="值，可引用 {{var}}" value={header.value} onChange={e => set(i, {value: e.target.value})}/>
          <button type="button" className="danger ghost" onClick={() => onPatch({headers: step.headers.filter((_, j) => j !== i)})}><Trash2 size={13}/></button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onPatch({headers: [...step.headers, {name: '', value: ''}]})}>+ 添加请求头</button>
    </div>
  );
}

function ConditionEditor({step, onPatch}: {step: ScenarioStep; onPatch: (patch: Partial<ScenarioStep>) => void}) {
  const condition = step.condition;
  return (
    <div className="kv-block condition-block">
      <label className="block-toggle">
        <input type="checkbox" checked={!!condition}
          onChange={e => onPatch({condition: e.target.checked ? {variable: '', op: 'notEmpty', value: ''} : null})}/>
        条件跳过
      </label>
      {condition && (
        <div className="row">
          <input aria-label="条件变量" placeholder="变量名" value={condition.variable}
            onChange={e => onPatch({condition: {...condition, variable: e.target.value}})}/>
          <select value={condition.op} onChange={e => {
            const op = e.target.value as NonNullable<ScenarioStep['condition']>['op'];
            onPatch({condition: {...condition, op}});
          }}>
            {OPS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
          </select>
          {(condition.op === 'equals' || condition.op === 'notEquals') && (
            <input className="grow" placeholder="比较值" value={condition.value}
              onChange={e => onPatch({condition: {...condition, value: e.target.value}})}/>
          )}
        </div>
      )}
      <small>条件变量未定义时按「空」处理，不会报未定义引用。</small>
    </div>
  );
}

function ExtractorsEditor({step, onPatch}: {step: ScenarioStep; onPatch: (patch: Partial<ScenarioStep>) => void}) {
  const set = (i: number, patch: Partial<{name: string; source: 'header' | 'json'; path: string}>) => {
    const extract = step.extract.map((item, j) => j === i ? {...item, ...patch} : item);
    onPatch({extract});
  };
  return (
    <div className="kv-block extract-block">
      <strong className="block-title">从响应提取变量</strong>
      {step.extract.map((item, i) => (
        <div className="row extract-row" key={i}>
          <input placeholder="变量名" value={item.name} onChange={e => set(i, {name: e.target.value})}/>
          <select aria-label="提取来源" value={item.source} onChange={e => set(i, {source: e.target.value as 'header' | 'json'})}>
            <option value="json">JSON 路径</option>
            <option value="header">响应头</option>
          </select>
          <input className="grow" placeholder={item.source === 'json' ? '$.items[0].id 或 $.items[*].id' : 'x-trace-id'}
            value={item.path} onChange={e => set(i, {path: e.target.value})}/>
          <button type="button" className="danger ghost" onClick={() => onPatch({extract: step.extract.filter((_, j) => j !== i)})}><Trash2 size={13}/></button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onPatch({extract: [...step.extract, {name: '', source: 'json', path: ''}]})}>+ 添加提取器</button>
    </div>
  );
}
