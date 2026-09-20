import {useEffect,useMemo,useState} from 'react';
import {ArrowDown,ArrowUp,Ban,FlaskConical,Play,Plus,Save,Search,Trash2} from 'lucide-react';
import {analyzeScenario,parseScenario,type Diagnostic,type RunRecord,type RunStepRecord,type RunSummary,type ScenarioDef,type StepDef} from '../shared/scenario';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

const METHODS=['GET','POST','PUT','PATCH','DELETE','HEAD'];

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [status,setStatus]=useState('Ready');
  const [mode,setMode]=useState<'steps'|'source'>('steps');
  const [runs,setRuns]=useState<RunSummary[]>([]);
  const [activeRun,setActiveRun]=useState<RunRecord|null>(null);
  const [runError,setRunError]=useState<string|null>(null);

  const parsed=useMemo(()=>parseScenario(draft),[draft]);
  const diagnostics=useMemo<Diagnostic[]>(()=>parsed.def?analyzeScenario(parsed.def):[{level:'error',message:parsed.error??'invalid scenario'}],[parsed]);
  const dirty=row!==null&&draft!==row.content;

  useEffect(()=>{fetch('/api/scenarios').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{
    setStatus('Loading');setActiveRun(null);setRunError(null);setAnalysis(null);
    fetch('/api/scenarios/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')});
    fetch(`/api/scenarios/${selected}/runs`).then(r=>r.json()).then((list:RunSummary[])=>{
      setRuns(list);
      if(list.length)fetch('/api/runs/'+list[0].id).then(r=>r.json()).then(setActiveRun);
    });
  },[selected]);
  // Poll the active run until it reaches a terminal state; runs live on the
  // server, so reloading the page re-attaches to the same records.
  useEffect(()=>{
    if(!activeRun||activeRun.status!=='running')return;
    const timer=setInterval(async()=>{
      const r=await fetch('/api/runs/'+activeRun.id);
      if(!r.ok)return;
      const run:RunRecord=await r.json();
      setActiveRun(run);
      if(run.status!=='running')refreshRuns();
    },400);
    return()=>clearInterval(timer);
  },[activeRun?.id,activeRun?.status]);

  function refreshRuns(){fetch(`/api/scenarios/${selected}/runs`).then(r=>r.json()).then(setRuns)}

  async function save(){
    if(!row)return;
    setStatus('Saving');
    const response=await fetch('/api/scenarios/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});
    const value=await response.json();
    if(!response.ok){setStatus('Revision conflict');return}
    setRow(value);setStatus('Saved');
  }
  async function analyze(){
    if(!row)return;
    setStatus('Analyzing');
    const response=await fetch('/api/scenarios/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});
    setAnalysis(await response.json());setStatus('Ready');
  }
  async function startRun(){
    if(!row)return;
    setRunError(null);
    const r=await fetch(`/api/scenarios/${row.id}/runs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delayMs:200})});
    const value=await r.json();
    if(!r.ok){setRunError(value.details??value.error??'failed to start run');return}
    setActiveRun(value);refreshRuns();
  }
  async function cancelRun(){
    if(!activeRun)return;
    const r=await fetch(`/api/runs/${activeRun.id}/cancel`,{method:'POST'});
    const value=await r.json();
    if(r.ok||r.status===409){setActiveRun(value.run??value);refreshRuns()}
  }

  // Structured editing operates on the parsed definition and serializes back
  // into the same draft the Save flow persists.
  function updateDef(fn:(def:ScenarioDef)=>void){
    if(!parsed.def)return;
    const next:ScenarioDef=JSON.parse(JSON.stringify(parsed.def));
    fn(next);
    setDraft(JSON.stringify(next,null,2));
  }
  const updateStep=(i:number,patch:Partial<StepDef>)=>updateDef(def=>{Object.assign(def.steps[i],patch)});
  const moveStep=(i:number,dir:-1|1)=>updateDef(def=>{const j=i+dir;if(j<0||j>=def.steps.length)return;const [s]=def.steps.splice(i,1);def.steps.splice(j,0,s)});
  const addStep=()=>updateDef(def=>def.steps.push({id:`step${def.steps.length+1}`,method:'GET',url:'',headers:{},onExtractError:'abort',extract:[]}));
  const removeStep=(i:number)=>updateDef(def=>{def.steps.splice(i,1)});
  const setHeader=(i:number,hi:number,key:string,value:string)=>updateDef(def=>{
    const entries=Object.entries(def.steps[i].headers);entries[hi]=[key,value];def.steps[i].headers=Object.fromEntries(entries);
  });
  const addHeader=(i:number)=>updateDef(def=>{def.steps[i].headers={...def.steps[i].headers,'':''}});
  const removeHeader=(i:number,hi:number)=>updateDef(def=>{
    const entries=Object.entries(def.steps[i].headers);entries.splice(hi,1);def.steps[i].headers=Object.fromEntries(entries);
  });

  const errors=diagnostics.filter(d=>d.level==='error');
  return <main className="shell">
    <header className="topbar"><FlaskConical size={20}/><strong>API Scenario Studio</strong><small>Local workspace</small></header>
    <section className="workspace">
      <aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button>
          <button onClick={analyze}><Search size={15}/>Analyze</button>
          <button onClick={startRun} disabled={!row||dirty} title={dirty?'Save changes before running (runs use the saved revision)':''}><Play size={15}/>Run</button>
          <span className="spacer"/>
          <button className={mode==='steps'?'active':''} onClick={()=>setMode('steps')}>Steps</button>
          <button className={mode==='source'?'active':''} onClick={()=>setMode('source')}>Source</button>
          <span>{status}{dirty?' · unsaved changes':''}</span>
        </div>
        {errors.length>0&&<div className="diag-strip">{errors.slice(0,3).map((d,i)=><span key={i} className="diag error">{d.step?d.step+': ':''}{d.message}</span>)}{errors.length>3&&<span className="diag error">+{errors.length-3} more</span>}</div>}
        {mode==='source'||!parsed.def
          ?<>
            {mode==='steps'&&!parsed.def&&<p className="diag error">Not a valid scenario definition — edit the source: {parsed.error}</p>}
            <textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)} spellCheck={false}/>
          </>
          :<div className="steps">
            {parsed.def.steps.map((step,i)=><StepCard
              key={i} step={step} index={i} count={parsed.def!.steps.length}
              diagnostics={diagnostics.filter(d=>d.step===step.id)}
              onPatch={p=>updateStep(i,p)} onMove={d=>moveStep(i,d)} onRemove={()=>removeStep(i)}
              onSetHeader={(hi,k,v)=>setHeader(i,hi,k,v)} onAddHeader={()=>addHeader(i)} onRemoveHeader={hi=>removeHeader(i,hi)}
              onUpdateExtract={(ei,p)=>updateDef(def=>{Object.assign(def.steps[i].extract[ei],p)})}
              onAddExtract={()=>updateDef(def=>def.steps[i].extract.push({name:'',from:'json',key:'$.'}))}
              onRemoveExtract={ei=>updateDef(def=>{def.steps[i].extract.splice(ei,1)})}
            />)}
            <button onClick={addStep}><Plus size={14}/>Add step</button>
          </div>}
      </section>
      <aside className="pane">
        <h2>Checks</h2>
        {diagnostics.length===0?<p className="ok">No problems found.</p>:<ul className="diags">{diagnostics.map((d,i)=><li key={i} className={`diag ${d.level}`}>{d.step&&<span className="pill">{d.step}</span>} {d.message}</li>)}</ul>}
        {analysis!==null&&<details><summary>Analyze result</summary><pre>{JSON.stringify(analysis,null,2)}</pre></details>}
        <h2>Runs</h2>
        {runError&&<p className="diag error">{runError}</p>}
        <div className="list runs">
          {runs.map(r=><button key={r.id} className={activeRun?.id===r.id?'active':''} onClick={()=>fetch('/api/runs/'+r.id).then(x=>x.json()).then(setActiveRun)}>
            <span className={`pill st-${r.status}`}>{r.status}</span> rev {r.revision} · {r.finishedSteps}/{r.steps} steps<br/><small>{r.createdAt}</small>
          </button>)}
          {runs.length===0&&<p>No runs yet.</p>}
        </div>
        {activeRun&&<div className="run-detail">
          <div className="run-head">
            <span className={`pill st-${activeRun.status}`}>{activeRun.status}</span>
            <small>revision {activeRun.revision}</small>
            {activeRun.status==='running'&&<button onClick={cancelRun}><Ban size={13}/>Cancel</button>}
          </div>
          {activeRun.steps.map(s=><RunStepView key={s.index} step={s}/>)}
          {activeRun.status!=='running'&&<><h3>Final variables</h3><pre>{JSON.stringify(activeRun.variables,null,2)}</pre></>}
        </div>}
      </aside>
    </section>
  </main>;
}

function StepCard(props:{
  step:StepDef;index:number;count:number;diagnostics:Diagnostic[];
  onPatch:(p:Partial<StepDef>)=>void;onMove:(d:-1|1)=>void;onRemove:()=>void;
  onSetHeader:(hi:number,k:string,v:string)=>void;onAddHeader:()=>void;onRemoveHeader:(hi:number)=>void;
  onUpdateExtract:(ei:number,p:Partial<StepDef['extract'][number]>)=>void;onAddExtract:()=>void;onRemoveExtract:(ei:number)=>void;
}){
  const {step,index,count,diagnostics}=props;
  return <div className="step-card">
    <div className="step-head">
      <span className="pill">#{index+1}</span>
      <input className="step-id" value={step.id} onChange={e=>props.onPatch({id:e.target.value})} aria-label="step id"/>
      <select value={step.method} onChange={e=>props.onPatch({method:e.target.value})}>{METHODS.map(m=><option key={m}>{m}</option>)}</select>
      <span className="spacer"/>
      <button title="Move up" disabled={index===0} onClick={()=>props.onMove(-1)}><ArrowUp size={14}/></button>
      <button title="Move down" disabled={index===count-1} onClick={()=>props.onMove(1)}><ArrowDown size={14}/></button>
      <button title="Delete step" onClick={props.onRemove}><Trash2 size={14}/></button>
    </div>
    <input className="url" value={step.url} placeholder="https://… or {{baseUrl}}/…" onChange={e=>props.onPatch({url:e.target.value})} aria-label="url"/>
    <div className="grid2">
      <div>
        <h4>Headers</h4>
        {Object.entries(step.headers).map(([k,v],hi)=><div className="kv" key={hi}>
          <input value={k} placeholder="name" onChange={e=>props.onSetHeader(hi,e.target.value,v)}/>
          <input value={v} placeholder="value or {{var}}" onChange={e=>props.onSetHeader(hi,k,e.target.value)}/>
          <button onClick={()=>props.onRemoveHeader(hi)}><Trash2 size={13}/></button>
        </div>)}
        <button onClick={props.onAddHeader}><Plus size={13}/>Header</button>
      </div>
      <div>
        <h4>Body</h4>
        <textarea className="body" value={step.body??''} placeholder='{"user": "{{name}}"}' onChange={e=>props.onPatch({body:e.target.value})} spellCheck={false}/>
      </div>
    </div>
    <div className="grid2">
      <div>
        <h4>Skip if</h4>
        <input value={step.skipIf??''} placeholder="{{flag}} — skips when true" onChange={e=>props.onPatch({skipIf:e.target.value})}/>
      </div>
      <div>
        <h4>On extraction error</h4>
        <select value={step.onExtractError} onChange={e=>props.onPatch({onExtractError:e.target.value as StepDef['onExtractError']})}>
          <option value="abort">abort run</option>
          <option value="skip">skip extractions, continue</option>
        </select>
      </div>
    </div>
    <h4>Extract variables</h4>
    {step.extract.map((ex,ei)=><div className="kv extract" key={ei}>
      <input value={ex.name} placeholder="variable" onChange={e=>props.onUpdateExtract(ei,{name:e.target.value})}/>
      <select value={ex.from} onChange={e=>props.onUpdateExtract(ei,{from:e.target.value as 'header'|'json'})}>
        <option value="header">header</option><option value="json">json path</option>
      </select>
      <input value={ex.key} placeholder={ex.from==='header'?'x-auth-token':'$.user.id'} onChange={e=>props.onUpdateExtract(ei,{key:e.target.value})}/>
      <button onClick={()=>props.onRemoveExtract(ei)}><Trash2 size={13}/></button>
    </div>)}
    <button onClick={props.onAddExtract}><Plus size={13}/>Extraction</button>
    {diagnostics.length>0&&<ul className="diags">{diagnostics.map((d,i)=><li key={i} className={`diag ${d.level}`}>{d.message}</li>)}</ul>}
  </div>;
}

function RunStepView({step}:{step:RunStepRecord}){
  return <details className="run-step" open={step.status==='failed'}>
    <summary>
      <span className={`pill st-${step.status}`}>{step.status}</span> <strong>{step.stepId}</strong>
      {step.request&&<code>{step.request.method} {step.request.url}</code>}
    </summary>
    {step.error&&<p className="diag error">{step.error}</p>}
    {step.request&&<div><h4>Request (values actually used)</h4>
      <pre>{step.request.method} {step.request.url}{Object.entries(step.request.headers).map(([k,v])=>`\n${k}: ${v}`).join('')}{step.request.body!==undefined?'\n\n'+step.request.body:''}</pre>
    </div>}
    {step.response&&<div><h4>Response · {step.response.status}</h4><pre>{step.response.body||'(empty)'}</pre></div>}
    {step.extractions&&step.extractions.length>0&&<div><h4>Extractions</h4>
      <ul className="diags">{step.extractions.map((x,i)=><li key={i} className={x.ok?'':'diag error'}>{x.ok?`${x.name} = ${JSON.stringify(x.value)}`:`${x.name}: ${x.error}`}</li>)}</ul>
    </div>}
    {step.variablesAfter&&<div><h4>Variables after this step</h4><pre>{JSON.stringify(step.variablesAfter,null,2)}</pre></div>}
  </details>;
}
