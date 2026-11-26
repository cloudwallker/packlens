import type {PublicPackReport, PublicRuleSource, PublicEvidence} from './serialization.ts';
import type {EditorState} from './server.ts';
import type {Patch} from './model.ts';
/** Self-contained browser controller: it displays computed DTOs, never matches npm rules. */
export function reportClient() {
  const data=JSON.parse(document.getElementById('report-data')!.textContent!) as {
    locale:string;
    reports:PublicPackReport[]
  };
  const liveNode=document.getElementById('live-data');
  const live=liveNode?JSON.parse(liveNode.textContent!) as {
    credential:string
  }:null;
  liveNode?.remove();
  const zh=data.locale!=='en';
  const t=(cn:string,en:string)=>zh?cn:en;
  let reports=data.reports,current=reports.length-1,selected='',page=0,busy=false,editor:EditorState;
  const collapsed=new Set<string>();
  const app=document.getElementById('app')!;
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='')=>{
    const e=document.createElement(tag);
    e.textContent=text;
    e.className=className;
    return e;
  };
  const button=(text:string,action:()=>void)=>{
    const e=make('button',text) as HTMLButtonElement;
    e.type='button';
    e.onclick=action;
    return e;
  };
  const label=(text:string,element:HTMLElement)=>{
    const l=make('label',text);
    l.append(element);
    return l;
  };
  const field=<K extends keyof HTMLElementTagNameMap>(tag:K,id:string)=>{
    const e=document.createElement(tag);
    e.id=id;
    return e;
  };
  const header=make('header');
  header.append(make('p','PACKLENS / PACKAGE EVIDENCE','eyebrow'),make('h1',t('看清每个文件的入包原因','Understand every shipped file')));
  const mode=make('p',live?t('本地实时 · 虚拟试改','Local live · Virtual rules'):t('已保存场景 · 完全离线','Saved scenarios · Offline'),'mode');
  header.append(mode);
  const title=make('p','','muted');
  header.append(title);
  app.append(header);
  const toolbar=make('section','','toolbar');
  const scene=field('select','scenario') as HTMLSelectElement;
  toolbar.append(label(t('计算场景','Computed scenario'),scene));
  const omit=field('input','omit-text') as HTMLInputElement;
  omit.type='checkbox';
  toolbar.append(label(t('导出时隐藏规则正文','Omit rule text on export'),omit));
  const download=(text:string,name:string,type:string)=>{
    const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{
      type
    }));
    a.href=url;
    a.download=name;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const api=async(path:string,body?:unknown)=>{
    const res=await fetch('/api/'+path,{
      method:body===undefined?'GET':'POST',headers:{
        'x-packlens-session':live!.credential,...(body===undefined?{
        }:{
          'content-type':'application/json'
        })
      },body:body===undefined?undefined:JSON.stringify(body)
    });
    if(!res.ok){
      const e=await res.json() as {error?:{code:string};diagnostics?:PublicPackReport['diagnostics']};
      const recovery=e.diagnostics?.filter(d=>d.code==='CLEANUP_FAILED').map(d=>`${d.code} ${d.cleanupId??''} ${d.actionableNextStep??''}`).join(' · ');
      throw Error(recovery||e.error?.code||'REQUEST_FAILED');
    }return res;
  };
  const status=make('p','','notice');
  status.setAttribute('role','status');
  status.setAttribute('aria-live','polite');
  async function action(run:()=>Promise<void>){
    if(busy)return;
    busy=true;
    app.setAttribute('aria-busy','true');
    status.textContent=t('正在调用官方清单计算…','Computing the official file list…');
    setDisabled();
    try{
      await run();
      status.textContent=t('计算完成；源项目保持不变。','Calculation complete; source files are unchanged.');
    }catch(e){
      status.textContent=t('请求未完成，保留上次有效场景：','Request failed; last valid scene retained: ')+(e as Error).message;
    }finally{
      busy=false;
      app.setAttribute('aria-busy','false');
      setDisabled();
    }
  }
  const exportJson=button(t('导出 JSON','Export JSON'),()=>{
    const copy:PublicPackReport=structuredClone(reports[current]);
    if(omit.checked){
      delete copy.snapshot.manifest.files;
      copy.ruleSources.forEach((s)=>delete s.text);
      copy.evidence.forEach((e)=>delete e.pattern);
    }download(JSON.stringify(copy,null,2),'packlens-report.json','application/json');
  });
  toolbar.append(exportJson);
  if(live)toolbar.append(button(t('导出离线 HTML','Export offline HTML'),()=>void action(async()=>download(await (await api('export',{
    omitRuleText:omit.checked
  })).text(),'packlens-report.html','text/html'))));
  app.append(toolbar,status);
  const metrics=make('section','','metrics');
  app.append(metrics);
  const grid=make('div','','grid'),treePanel=make('section','','panel'),details=make('section','','panel');
  treePanel.append(make('h2',t('文件树','File tree')));
  details.append(make('h2',t('规则证据','Rule evidence')));
  const controls=make('div','','controls'),search=field('input','search') as HTMLInputElement;
  search.type='search';
  search.placeholder=t('搜索相对路径','Search relative paths');
  const filter=field('select','status-filter') as HTMLSelectElement;
  for(const [v,cn,en] of [['all','全部状态','All statuses'],['included','✓ 已包含','✓ Included'],['excluded','− 已排除','− Excluded'],['missing','○ 不存在','○ Missing'],['unknown','? 未知','? Unknown']]){
    const o=make('option',t(cn,en)) as HTMLOptionElement;
    o.value=v;
    filter.append(o);
  }   controls.append(label(t('路径','Path'),search),label(t('状态','Status'),filter));
  treePanel.append(controls);
  const tree=make('div','','tree'),pager=make('div','','pager'),pageText=make('span');
  const prev=button(t('上一页','Previous'),()=>{
    page--;
    renderTree();
  }),next=button(t('下一页','Next'),()=>{
    page++;
    renderTree();
  });
  pager.append(prev,pageText,next);
  treePanel.append(tree,pager);
  const detailBody=make('div');
  detailBody.id='evidence';
  details.append(detailBody);
  grid.append(treePanel,details);
  app.append(grid);
  const lower=make('section','','panel');
  const tabs=make('div','','toolbar'),assertions=make('div'),delta=make('div'),diagnostics=make('div');
  assertions.id='assertions';
  delta.id='delta';
  diagnostics.id='diagnostics';
  delta.hidden=true;
  diagnostics.hidden=true;
  for(const [text,target] of [[t('交付断言','Assertions'),assertions],[t('字节与路径变化','Delta'),delta],[t('诊断与覆盖范围','Diagnostics'),diagnostics]] as const)tabs.append(button(text,()=>{
    for(const p of [assertions,delta,diagnostics])p.hidden=p!==target;
  }));
  lower.append(tabs,assertions,delta,diagnostics);
  app.append(lower);
  function statusName(value:string){
    const names:Record<string,string>={
      included:t('✓ 已包含','✓ Included'),excluded:t('− 已排除','− Excluded'),missing:t('○ 不存在','○ Missing'),unknown:t('? 未知','? Unknown')
    };
    return names[value]??value;
  }
  function selectEntry(path:string,button:HTMLButtonElement){
    selected=path;
    for(const entry of tree.querySelectorAll<HTMLButtonElement>('.entry'))entry.setAttribute('aria-pressed',String(entry===button));
    renderDetails();
  }
  function renderTree(){
    const r=reports[current],query=search.value.toLowerCase();
    let entries=r.entries.filter((e)=>(!query||e.path.toLowerCase().includes(query))&&(filter.value==='all'||e.membership===filter.value)&&(![...collapsed].some(p=>e.path.startsWith(p+'/'))||query));
    entries.sort((a,b)=>a.path.localeCompare(b.path));
    page=Math.max(0,Math.min(page,Math.ceil(entries.length/100)-1));
    tree.replaceChildren();
    for(const e of entries.slice(page*100,page*100+100)){
      const row=make('div','','tree-row');
      row.style.paddingInlineStart=Math.min(3,e.path.split('/').length-1)*10+'px';
      if(e.kind==='directory'){
        const toggle=button(collapsed.has(e.path)?'▸':'▾',()=>{
          collapsed.has(e.path)?collapsed.delete(e.path):collapsed.add(e.path);
          renderTree();
        });
        toggle.setAttribute('aria-label',t('折叠或展开 ','Collapse or expand ')+e.path);
        toggle.setAttribute('aria-expanded',String(!collapsed.has(e.path)));
        row.append(toggle);
      }const select=button('',()=>selectEntry(e.path,select));
      select.className='entry';
      select.setAttribute('aria-pressed',String(selected===e.path));
      const children=e.kind==='directory'?r.entries.filter((item)=>item.kind==='file'&&item.exists&&item.path.startsWith(e.path+'/')):null;
      const summary=children?t('目录','Directory')+' · '+children.length+' '+t('文件','files')+' · '+children.filter((item)=>item.membership==='included').length+' '+t('已包含','included'):`${statusName(e.membership)} · ${e.rawBytes} B`;
      select.append(make('span',e.path,'path'),make('span',summary,children?'muted':e.membership));
      row.append(select);
      tree.append(row);
    }pageText.textContent=`${entries.length} ${t('项','items')} · ${page+1}/${Math.max(1,Math.ceil(entries.length/100))}`;
    prev.disabled=page===0;
    next.disabled=(page+1)*100>=entries.length;
  }
  function renderSource(source:PublicRuleSource){
    const pointer=source.path+(source.line?':'+source.line:'')+(source.jsonPointer?' '+source.jsonPointer:'');
    const text=make('pre',pointer+'\n'+(source.text??t('规则正文已隐藏或未公开','Rule text omitted or unavailable')));
    text.hidden=true;
    text.tabIndex=-1;
    const jump=button(pointer,()=>{
      text.hidden=false;
      text.focus();
    });
    jump.className='source-link';
    return [jump,text];
  }
  function renderEvidence(ev:PublicEvidence,sources:PublicRuleSource[]){
    const item=make('article','','evidence-item');
    item.append(make('p',ev.decision+' · '+ev.sourceMapping+' · '+ev.before+' → '+ev.after));
    if(ev.pattern!==undefined)item.append(make('pre',ev.pattern));
    if(ev.ancestorChain.length)item.append(make('p',t('祖先阻断：','Ancestor chain: ')+ev.ancestorChain.join(' → ')));
    for(const id of ev.candidateSources){
      const source=sources.find(s=>s.sourceId===id);
      if(source)item.append(...renderSource(source));
    }return item;
  }
  function renderDetails(){
    const r=reports[current],entry=r.entries.find((e)=>e.path===selected);
    detailBody.replaceChildren();
    if(!entry){
      detailBody.append(make('p',t('选择文件查看实际规则、物理行与 JSON 指针。','Select a file to inspect evaluated rules, physical lines and JSON pointers.')));
      return;
    }detailBody.append(make('h3',entry.path,'path'),make('p',`${statusName(entry.membership)} · ${entry.rawBytes} B`),make('p',`${entry.membershipValidity} / ${entry.explanationStatus}`,'muted'));
    for(const ev of r.evidence.filter(e=>entry.evidenceIds.includes(e.evidenceId)))detailBody.append(renderEvidence(ev,r.ruleSources));
    if(!entry.evidenceIds.length)detailBody.append(make('p',t('此节点没有已记录的规则证据。','No evaluated rule evidence for this node.')));
  }
  function render(){
    const r=reports[current];
    scene.replaceChildren();
    reports.forEach((x,i)=>{
      const o=make('option',`${i===0?t('基础场景','Baseline'):t('虚拟场景','Virtual scene')} · r${x.scenario.revision}`) as HTMLOptionElement;
      o.value=String(i);
      scene.append(o);
    });
    scene.value=String(current);
    title.textContent=`${r.snapshot.projectLabel} · ${r.profile.profileId} · ${r.snapshot.capturedAt}`;
    metrics.replaceChildren();
    for(const [name,value] of [[t('官方文件数','Official files'),String(r.scenario.aggregate.fileCount)],[t('原始字节','Raw bytes'),r.scenario.aggregate.rawBytes+' B'],[t('基础字节','Baseline bytes'),reports[0].scenario.aggregate.rawBytes+' B'],[t('有效性','Validity'),r.complete?t('完整计算','Complete'):t('未完成 / 未知','Incomplete / unknown')]]){
      const card=make('div','','metric');
      card.append(make('p',name,'muted'),make('strong',value));
      metrics.append(card);
    }renderAssertions(r);
    renderDelta(r);
    renderDiagnostics(r);
    renderTree();
    renderDetails();
  }
  function renderAssertions(r:PublicPackReport){
    assertions.replaceChildren(make('h2',t('交付断言','Shipping assertions')));
    for(const a of r.scenario.assertions){
      const row=make('article','','assertion');
      row.append(make('strong',`${a.status==='pass'?'✓':a.status==='fail'?'×':'?'} ${a.type} · ${a.status}`,a.status),make('p',typeof a.selector==='string'?a.selector:a.selector.join(', '),'path'),make('p',`${a.reasonCodes.join(', ')}${a.bytesActual!==undefined?' · '+a.bytesActual+' / '+a.bytesLimit+' B':''}`));
      if (a.excludedSelectors?.length) row.append(make('p', t('预算排除', 'Excluded from budget') + ': ' + a.excludedSelectors.join(', '), 'path'));
      assertions.append(row);
    }if(!r.scenario.assertions.length)assertions.append(make('p',t('本场景未指定意图。','No intent supplied.')));
  }
  function renderDelta(r:PublicPackReport){
    delta.replaceChildren(make('h2',t('相对基础场景的精确差异','Exact delta from baseline')));
    if(r.scenario.delta){
      const d=r.scenario.delta;
      delta.append(make('p',`+${d.addedRawBytes} B / −${d.removedRawBytes} B · ${t('净变化','Net')} ${d.netRawBytes} B`));
      for(const p of d.addedPaths)delta.append(make('p','+ '+p,'included path'));
      for(const p of d.removedPaths)delta.append(make('p','− '+p,'excluded path'));
      for(const c of d.retainedContentByteChanges)delta.append(make('p',`${c.path}: ${c.beforeRawBytes} → ${c.afterRawBytes} B (${c.deltaRawBytes})`,'path'));
    }else delta.append(make('p',t('基础场景或不完整计算没有可确认差异。','Baseline or incomplete calculation has no verified delta.')));
  }
  function renderDiagnostics(r:PublicPackReport){
    diagnostics.replaceChildren(make('h2',t('诊断与规则状态','Diagnostics and rule states')));
    for(const d of r.diagnostics)diagnostics.append(make('p',`${d.code} · ${d.relativePath??''} · ${d.message}${d.cleanupId?' · '+d.cleanupId:''}${d.actionableNextStep?' · '+d.actionableNextStep:''}`));
    for(const s of r.ruleSources.filter((s)=>s.active===false||s.zeroMatch))diagnostics.append(make('p',`${s.path} ${s.jsonPointer??''} · ${s.inactiveReason??'ZERO_MATCH'}`));
  }
  scene.onchange=()=>{
    current=Number(scene.value);
    page=0;
    render();
  };
  search.oninput=filter.onchange=()=>{
    page=0;
    renderTree();
  };
  const editControls:HTMLButtonElement[]=[];
  function setDisabled(){
    for(const b of editControls)b.disabled=busy;
  }
  if(live){
    const section=make('section','','panel');
    section.append(make('h2',t('虚拟规则编辑器','Virtual rule editor')),make('p',t('只修改本会话中的 files 与 ignore；每次重算调用官方清单。','Edit files and ignore in this session; each calculation runs the official file list.')));
    const target=field('select','edit-target') as HTMLSelectElement,area=field('textarea','rule-editor') as HTMLTextAreaElement;
    area.rows=7;
    area.spellcheck=false;
    function loadEditor(){
      target.replaceChildren();
      for(const path of ['package.json files',...Object.keys(editor.ignores)]){
        const o=make('option',path) as HTMLOptionElement;
        o.value=path;
        target.append(o);
      }target.value=Object.keys(editor.ignores).find(p=>p.endsWith('dist/.npmignore'))??'package.json files';
      showText();
    }
    function showText(){
      area.value=target.value==='package.json files'?JSON.stringify(editor.files??[],null,2):editor.ignores[target.value];
    }     target.onchange=showText;
    section.append(label(t('规则文件','Rule file'),target),label(t('虚拟文本','Virtual text'),area));
    const patchArea=field('textarea','patch-editor') as HTMLTextAreaElement;
    patchArea.rows=5;
    patchArea.value='{"schemaVersion":1,"operations":[]}';
    patchArea.spellcheck=false;
    const advance=async(path:string,body:unknown)=>{
      const res=await (await api(path,body)).json() as {
        report:PublicPackReport;
        editor:EditorState
      };
      reports.push(res.report);
      current=reports.length-1;
      editor=res.editor;
      loadEditor();
      render();
    };
    const apply=button(t('重算虚拟规则','Recalculate virtual rules'),()=>void action(async()=>{
      const op=target.value==='package.json files'?{
        op:'replaceFiles',value:JSON.parse(area.value)
      }:{
        op:'replaceIgnoreText',path:target.value,value:area.value,expected:editor.ignores[target.value]
      };
      await advance('apply',{
        schemaVersion:1,expectedRevision:editor.revision,operations:[op]
      });
    }));
    const undo=button(t('撤销','Undo'),()=>void action(()=>advance('undo',{
      expectedRevision:editor.revision
    }))),reset=button(t('重置','Reset'),()=>void action(()=>advance('reset',{
      expectedRevision:editor.revision
    })));
    section.append(apply,undo,reset);
    const advanced=make('details'),summary=make('summary',t('高级：原子 patch（新增 / 删除 ignore、物理行编辑）','Advanced: atomic patch (create/delete ignore, physical line edits)'));
    advanced.append(summary,label('Patch JSON',patchArea));
    const patchButton=button(t('计算 patch','Compute patch'),()=>void action(async()=>{
      const patch=JSON.parse(patchArea.value) as Patch;
      patch.expectedRevision=editor.revision;
      await advance('apply',patch);
    }));
    advanced.append(patchButton);
    section.append(advanced);
    editControls.push(apply,undo,reset,patchButton);
    app.append(section);
    void action(async()=>{
      editor=await (await api('editor')).json() as EditorState;
      loadEditor();
    });
  }
  const footer=make('footer',t('使用已构建的单包快照 · 原始字节 B · 生命周期不执行 · 本地报告可能包含项目规则','Uses the built standalone package snapshot · Raw bytes B · Lifecycle scripts disabled · Local report may contain project rules'));
  app.append(footer);
  render();
}

export const reportStyles=`:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#0F172A;color:#F8FAFC}
*{box-sizing:border-box}
body{margin:0}
main{max-width:1500px;margin:auto;padding:32px}
header{margin-bottom:24px}
h1{font-size:clamp(1.8rem,4vw,2.7rem);letter-spacing:-.04em;margin:8px 0 16px}
h2{font-size:1.15rem;margin:0 0 18px}
h3{font-size:1rem}
.eyebrow{color:#94A3B8;font-size:12px;font-weight:700;letter-spacing:.16em}
.mode{display:inline-block;border:1px solid #475569;border-radius:6px;padding:8px 12px}
.muted,footer{color:#94A3B8}
.toolbar,.controls,.pager{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.toolbar{margin-bottom:12px}
.controls{align-items:stretch}
.controls label{flex:1;min-width:130px}
label{display:flex;gap:6px;flex-direction:column;font-size:14px;color:#CBD5E1}
label:has(input[type=checkbox]){flex-direction:row;align-items:center;min-height:44px}
button,input,select,textarea{font:inherit;color:inherit;background:#111b2e;border:1px solid #475569;border-radius:6px;min-height:44px;max-width:100%;padding:9px 12px}
button{cursor:pointer}
button:hover{background:#28354c}
button:disabled{opacity:.45;cursor:wait}
:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}
input[type=checkbox]{width:20px;min-height:20px}
textarea{width:100%;font:14px/1.65 ui-monospace,monospace;resize:vertical;margin-bottom:16px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:18px 0 24px}
.metric,.panel{background:#1B2336;border:1px solid #475569;border-radius:10px;padding:20px;min-width:0}
.metric p{margin:0 0 10px}
.metric strong{font-size:1.35rem;overflow-wrap:anywhere}
.grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:20px;margin-bottom:20px}
.panel{margin-bottom:20px}
.grid .panel{margin:0}
.tree{margin-top:18px;max-height:570px;overflow:auto}
.tree-row{display:flex;gap:4px;border-bottom:1px solid #334155}
.tree-row>button:not(.entry){width:44px;flex-shrink:0}
.entry{border:0;background:transparent;display:flex;flex-direction:column;gap:5px;align-items:flex-start;text-align:left;width:100%;min-width:0}
.entry[aria-pressed=true]{background:#263956}
.path{font-family:ui-monospace,monospace;overflow-wrap:anywhere;word-break:break-word}
.entry span:last-child{font-size:12px}
.included,.pass{color:#4ade80}
.excluded,.fail{color:#fda4af}
.missing,.unknown{color:#fbbf24}
.pager{justify-content:space-between;margin-top:16px;font-size:13px}
.evidence-item,.assertion{border-top:1px solid #475569;padding:12px 0}
.source-link{display:block;width:100%;text-align:left;color:#93c5fd;overflow-wrap:anywhere;margin-bottom:8px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#111b2e;border-radius:6px;padding:12px;font:13px/1.6 ui-monospace,monospace;max-height:260px;overflow:auto}
.notice{min-height:24px;color:#cbd5e1}
.panel>button{margin:0 8px 12px 0}
summary{cursor:pointer;min-height:44px;padding:12px 0}
footer{font-size:12px;line-height:1.8;margin-top:24px}
p{overflow-wrap:anywhere}
[hidden]{display:none!important}
@media(max-width:700px){main{padding:16px}
.metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.metric,.panel{padding:14px}
.grid{grid-template-columns:minmax(0,1fr)}
.toolbar>*{max-width:100%}
.tree{max-height:420px}
.controls{display:grid;grid-template-columns:minmax(0,1fr)}
.controls label{min-width:0}
.pager{gap:6px}
h1{font-size:1.85rem}
}
`;
