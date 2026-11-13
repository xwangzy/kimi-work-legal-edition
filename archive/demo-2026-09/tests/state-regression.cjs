'use strict';
// State and rendering regressions against the actual scripts. No browser/network dependencies.
// The small DOM mock supports the controls exercised here; it does not verify layout or accessibility.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const FILES = ['legal-scenarios.js', 'app.js', 'legal-workspace.js', 'legal-skills.js', 'legal-connections-plus.js', 'legal-launcher.js', 'legal-workpapers.js'];
const WORKSPACE_KEY = 'kw-legal-workspace-v2';
const SKILLS_KEY = 'kw-legal-skills-v2';
const decode = value => String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function harness(seed = {}, hash = '') {
  const data = new Map(Object.entries(seed));
  const events = {document: {}, window: {}};
  const nodes = new Map();
  const groups = new Map();
  let renderedControls = [];
  const timers = new Map();
  const microtasks = [];
  let timerId = 0, now = 0, reloaded = false;
  const on = (scope, name, fn) => (events[scope][name] ||= []).push(fn);
  class Element {
    constructor(id = '') { this.id = id; this.value = ''; this.dataset = {}; this.checked = false; this.isConnected = true; this.style = {}; this.tagName = 'INPUT'; this._html = ''; this.classList = {add() {}, remove() {}, toggle() {}}; }
    get innerHTML() { return this._html; }
    set innerHTML(html) { this._html = String(html); parse(this._html, this.id); }
    focus() { document.activeElement = this; }
    setSelectionRange() {}
    scrollIntoView() {}
    getClientRects() { return [1]; }
    insertAdjacentHTML(_, html) { this.innerHTML += html; }
    querySelector(s) { return document.querySelector(s); }
    querySelectorAll(s) { return document.querySelectorAll(s); }
    closest(selector) { const m = selector.match(/^\[data-([a-z0-9-]+)\]$/); if (!m) return null; const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return this.dataset[key] === undefined ? null : this; }
  }
  function parse(html, owner) {
    renderedControls = renderedControls.filter(el => el.owner !== owner);
    for (const match of html.matchAll(/<(input|textarea)\b([^>]*)(?:>([\s\S]*?)<\/\1>|>)/g)) {
      const el = new Element(); el.owner = owner; el.tagName = match[1].toUpperCase();
      el.value = decode(match[1] === 'textarea' ? match[3] : match[2].match(/\bvalue="([^"]*)"/)?.[1]);
      el.checked = /\bchecked\b/.test(match[2]);
      for (const attr of match[2].matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) el.dataset[attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decode(attr[2]);
      renderedControls.push(el);
    }
    if (owner === 'overlay') for (const [id, el] of nodes) if (el.owner === 'overlay') nodes.delete(id);
    for (const m of html.matchAll(/<[a-z][a-z0-9-]*\b[^>]*\bid="([^"]+)"[^>]*>/g)) { const el = new Element(m[1]); el.owner = owner; nodes.set(el.id, el); }
    for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*\bid="([^"]+)"[^>]*)(?:>([\s\S]*?)<\/\1>|>)/g)) {
      const el = new Element(m[3]); el.owner = owner; el.tagName = m[1].toUpperCase();
      if (m[1] === 'textarea') el.value = decode(m[4]);
      else if (m[1] === 'select') { const options = [...String(m[4]).matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)]; const selected = options.find(x => /\bselected\b/.test(x[1])) || options[0]; el.value = selected ? decode(selected[1].match(/value="([^"]*)"/)?.[1] ?? selected[2]) : ''; }
      else el.value = decode(m[2].match(/\bvalue="([^"]*)"/)?.[1]);
      el.checked = /\bchecked\b/.test(m[2]); for (const a of m[2].matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) el.dataset[a[1].replace(/-([a-z])/g, (_,c)=>c.toUpperCase())]=decode(a[2]); nodes.set(el.id, el);
    }
    if (owner === 'overlay' || owner === 'connection-tool-checks') {
      if(owner === 'overlay')groups.clear();else groups.delete('connection-tool');
      for (const m of html.matchAll(/<input\b([^>]*\bname="([^"]+)"[^>]*)>/g)) { const el = new Element(); el.value = decode(m[1].match(/\bvalue="([^"]*)"/)?.[1]); el.checked = /\bchecked\b/.test(m[1]); const list = groups.get(m[2]) || []; list.push(el); groups.set(m[2], list); }
    }
  }
  const generic = new Element();
  const document = {
    body: {style: {}}, activeElement: generic,
    addEventListener: (name, fn) => on('document', name, fn),
    querySelector: s => /^#[\w-]+$/.test(s) ? nodes.get(s.slice(1)) || null : generic,
    querySelectorAll: s => { const name = s.match(/\[name="([^"]+)"\]/)?.[1]; if (name) return (groups.get(name) || []).filter(el => !s.includes(':checked') || el.checked); return []; },
    getElementById: id => nodes.get(id) || null,
    createElement: () => new Element()
  };
  for (const id of ['app','overlay','toast']) nodes.set(id, new Element(id));
  const location = {hash, reload() { reloaded = true; }};
  const context = {
    console, document, location, URL,
    history: {replaceState(_, __, next) { location.hash = next; }},
    localStorage: {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key)},
    setTimeout(fn, delay = 0) { const id = ++timerId; timers.set(id, {fn, due: now + delay}); return id; },
    clearTimeout: id => timers.delete(id),
    queueMicrotask: fn => microtasks.push(fn),
    requestAnimationFrame: fn => fn(),
    window: {addEventListener: (name, fn) => on('window', name, fn), scrollTo() {}}
  };
  vm.createContext(context);
  for (const file of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, {filename:file});
  const run = code => vm.runInContext(code, context);
  const flushMicrotasks = () => { while (microtasks.length) microtasks.shift()(); };
  const emit = (scope, name, event = {}) => { for (const fn of events[scope][name] || []) fn(event); flushMicrotasks(); };
  return {
    run, nodes, data, groups, location,
    boot() { vm.runInContext(fs.readFileSync(path.join(ROOT,'bootstrap.js'),'utf8'), context, {filename:'bootstrap.js'}); },
    click(key, action, id = '', extra = {}) { const target = new Element(); target.tagName='BUTTON'; target.dataset[key]=action; target.dataset.id=id; target.dataset.skillId=id; Object.assign(target.dataset,extra); emit('document','click',{target,preventDefault(){},stopPropagation(){}}); },
    field(id, value) { assert(nodes.has(id), `Missing form control #${id}`); nodes.get(id).value=String(value); },
    input(id, value) { assert(nodes.has(id), `Missing form control #${id}`); const target=nodes.get(id);target.value=String(value);emit('document','input',{target}); },
    control(dataset) { const target=renderedControls.find(el=>Object.entries(dataset).every(([key,value])=>el.dataset[key]===String(value)));assert(target, 'Missing rendered control '+JSON.stringify(dataset));return target; },
    emit,
    advance(ms) { const end = now + ms; let guard=100; while (guard--) { const next=[...timers.entries()].sort((a,b)=>a[1].due-b[1].due)[0]; if(!next||next[1].due>end)break; timers.delete(next[0]); now=next[1].due; next[1].fn(); flushMicrotasks(); } now=end; assert(guard>0,'Timer loop did not settle'); },
    saved() { return Object.fromEntries(data); },
    get reloaded() { return reloaded; }
  };
}

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`PASS ${name}`); } catch(error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); } }
function configureSkill(h, id='contract') {
  h.click('skillAction','edit',id);
  h.field('skill-config-name','本所技术合同审查'); h.field('skill-config-version','v9.3');
  h.field('skill-config-instructions','检查付款、验收与附件。保留缺口并人工复核。');
  h.click('skillAction','save',id);
}
function createConnection(h) {
  h.click('v2Action','custom-connector');
  h.field('custom-connection-name','内部法规库'); h.field('custom-connection-description','仅供本所示例研究');
  h.click('v2Action','create-connector');
  const id=h.run('v2.connectors.at(-1).id');
  h.field('connection-endpoint','https://demo.example.test/legal-mcp');
  h.click('v2Action','test-connector',id); h.click('v2Action','save-connector',id);
  return id;
}
function prepareRun(h, route='contract') { h.run(`setup(${JSON.stringify(route)});plan();run();`); }

test('all declared routes render through actual views without recursion', () => {
  const h=harness(); h.boot();
  for (const route of JSON.parse(h.run('JSON.stringify(Object.keys(routeTitles))'))) {
    assert.doesNotThrow(()=>h.run(`navigate(${JSON.stringify(route)})`), route);
    assert(h.nodes.get('app').innerHTML.includes('legal-shell'), route+' did not render shell');
  }
  for(const project of [0,1,2]) { h.run(`state.project=${project};navigate('project');navigate('delivery')`); assert(h.nodes.get('app').innerHTML.includes('交付'), 'project '+project); }
  assert.equal(h.run('originalProjectView===projectView'),false);
  assert.equal(h.run('originalPleadingView===pleadingView'),false);
});

test('custom connection creation, test, enable and refresh retain endpoint and tools', () => {
  const h=harness(); const id=createConnection(h);
  assert.equal(h.run(`connectionReady(connectorById(${JSON.stringify(id)}))`),true);
  const refreshed=harness(h.saved());
  assert.equal(refreshed.run('v2.connectors.length'),7);
  assert.equal(refreshed.run(`connectorById(${JSON.stringify(id)}).endpoint`),'https://demo.example.test/legal-mcp');
  assert.equal(refreshed.run(`connectionReady(connectorById(${JSON.stringify(id)}))`),true);
});

test('skill editing and disabled state persist and are honored by setup', () => {
  const h=harness();configureSkill(h);h.click('skillAction','toggle','contract');
  assert.equal(h.run("window.LegalSkills.enabled('contract')"),false);
  const refreshed=harness(h.saved());
  assert.equal(refreshed.run("window.LegalSkills.config('contract').version"),'v9.3');
  assert.equal(refreshed.run("window.LegalSkills.config('contract').enabled"),false);
  refreshed.run("setup('contract')");assert(refreshed.nodes.get('overlay').innerHTML.includes('该技能已停用'));
  refreshed.run('showSkillPicker()');assert(!refreshed.nodes.get('overlay').innerHTML.includes('data-skill-id="contract"'));
});

test('saved skill rules and connection state reach execution snapshot', () => {
  const h=harness();configureSkill(h);
  h.click('v2Action','configure-connector','legal-search');h.click('v2Action','test-connector','legal-search');h.click('v2Action','save-connector','legal-search');
  h.run("setup('contract');plan()");
  assert.equal(h.run('state.executionSnapshot.version'),'v9.3');
  assert(h.run('state.executionSnapshot.instructions').includes('人工复核'));
  assert.equal(h.run("state.executionSnapshot.tools.find(t=>t.id==='legal-search').ready"),true);
  const refreshed=harness(h.saved());assert.equal(refreshed.run("connectionReady(connectorById('legal-search'))"),true);
});

test('cancel before and during replay leaves no successful run', () => {
  for(const elapsed of [0,700]) { const h=harness();prepareRun(h);h.advance(elapsed);h.click('action','close');h.advance(3000);assert.equal(h.run('v2.taskRuns.length'),0);assert.equal(h.run('state.taskStarted'),false);assert.equal(h.run('state.runTimer'),null); }
});

test('completed replay creates exactly one durable success with its skill snapshot', () => {
  const h=harness();configureSkill(h);prepareRun(h);assert.equal(h.run('v2.taskRuns.length'),0);h.advance(1500);
  assert.equal(h.run('v2.taskRuns.length'),1);assert.equal(h.run('v2.taskRuns[0].version'),'v9.3');assert.equal(h.run('state.route'),'contract');
  h.click('action','resume','contract');assert(h.run('state.playbook').includes('v9.3'));
  const refreshed=harness(h.saved());assert.equal(refreshed.run('v2.taskRuns.length'),1);
});

test('reset survives global click microtask, pagehide and reload', () => {
  const h=harness();configureSkill(h);createConnection(h);assert(h.data.has(WORKSPACE_KEY));assert(h.data.has(SKILLS_KEY));
  h.click('v2Action','reset-workspace');h.emit('window','pagehide');h.run('persistWorkspace()');
  assert.equal(h.reloaded,true);assert.equal(h.data.has(WORKSPACE_KEY),false);assert.equal(h.data.has(SKILLS_KEY),false);
  const refreshed=harness(h.saved());assert.equal(refreshed.run('v2.connectors.length'),6);assert.equal(refreshed.run("window.LegalSkills.config('contract').version"),'v2.4');
});

test('deep links and hash navigation normalize project; deliveries remain scoped', () => {
  const initial=harness();initial.run('state.project=2;persistWorkspace()');
  const h=harness(initial.saved(),'#contract');h.boot();assert.equal(h.run('state.project'),0);
  h.run("navigate('delivery')");assert(h.nodes.get('app').innerHTML.includes('软件采购合同 · 交付中心'));
  h.location.hash='#matrix';h.emit('window','hashchange');assert.equal(h.run('state.project'),2);
  h.run("navigate('delivery')");assert(h.nodes.get('app').innerHTML.includes('专项尽调 · 交付中心'));
  h.run("navigate('evidence');navigate('delivery')");assert.equal(h.run('state.project'),1);assert(h.nodes.get('app').innerHTML.includes('买卖合同纠纷 · 交付中心'));
});

test('new project files and delivery cannot inherit another project results', () => {
  const h=harness();h.click('v2Action','new-project');h.field('new-project-name','隔离验证项目');h.field('new-project-role','采购方');h.click('v2Action','save-project');
  assert.equal(h.run('state.project'),3);assert(h.nodes.get('app').innerHTML.includes('项目材料在上方统一管理'));assert.equal(h.run('(v2.projectFiles[3]||[]).length'),0);assert(!h.nodes.get('app').innerHTML.includes('01_买卖合同.pdf'));
  h.run("navigate('delivery')");assert(h.nodes.get('app').innerHTML.includes('还没有交付成果'));assert(!h.nodes.get('app').innerHTML.includes('审查意见报告.html'));
  const refreshed=harness(h.saved());assert.equal(refreshed.run('projects[3].name'),'隔离验证项目');assert.equal(refreshed.run('state.project'),3);
});

test('review decisions and document draft survive refresh with Set types restored', () => {
  const h=harness();h.click('action','accept','0');h.run("state.matrixVerified.add('0-0');state.matrixLocked.add('0-0');state.pleading={claimant:'测试主体',defendant:'被告',amount:'120',court:'测试法院',interest:'待确认',facts:'测试事实'};persistWorkspace()");
  const refreshed=harness(h.saved());assert.equal(refreshed.run("issues[0].status"),'accepted');assert.equal(refreshed.run("state.matrixLocked.has('0-0')"),true);
  refreshed.run("navigate('pleading')");assert.equal(refreshed.nodes.get('claimant').value,'测试主体');assert.equal(refreshed.nodes.get('claim-facts').value,'测试事实');
});


function createEnterpriseDraft(h, project) {
  h.run(`state.project=${project}`);
  h.click('skillAction','prompt','enterprise-check');
  h.click('action','send');
  assert(h.nodes.get('overlay').innerHTML.includes('建立企业主体核查工作底稿'));
  h.click('v2Action','create-custom-draft','enterprise-check');
  return h.run('v2.activeDraftId');
}
function writeWorkpaper(h, key, value) {
  const target=h.nodes.get('workpaper-'+key);assert(target,'Missing workpaper field '+key);
  target.value=value;h.emit('document','input',{target});
}

test('selected enterprise skill sends to its workpaper and survives refresh without contract routing', () => {
  const h=harness();h.run('state.project=2');h.click('skillAction','prompt','enterprise-check');
  assert.equal(h.run('state.selectedSkill'),'enterprise-check');
  const refreshed=harness(h.saved(),'#home');refreshed.boot();refreshed.click('action','send');
  assert.equal(refreshed.run('state.project'),2);
  assert(refreshed.nodes.get('overlay').innerHTML.includes('建立企业主体核查工作底稿'));
  assert(!refreshed.nodes.get('overlay').innerHTML.includes('开始合同审查'));
  refreshed.click('v2Action','create-custom-draft','enterprise-check');
  assert.equal(refreshed.run('state.route'),'skill-workbench');
  assert.equal(refreshed.run('v2.customDraft.id'),'enterprise-check');
  assert.equal(refreshed.run('v2.customDraft.project'),2);
});

test('two workpapers preserve independent text after refresh and only appear in their project delivery', () => {
  const h=harness();
  // Keep rapid successive creations in the same millisecond to make ID collision coverage deterministic.
  h.run('Date.now=()=>1790000000000');
  const first=createEnterpriseDraft(h,0);writeWorkpaper(h,'facts','远山项目：核对企业登记');
  const second=createEnterpriseDraft(h,2);writeWorkpaper(h,'facts','启明项目：核对投资主体');
  assert.notEqual(first,second,'Each workpaper must have a distinct identity');assert.equal(h.run('v2.customDrafts.length'),2);
  const refreshed=harness(h.saved());refreshed.click('v2Action','open-draft',first);
  assert.equal(refreshed.run('state.project'),0);assert.equal(refreshed.nodes.get('workpaper-facts').value,'远山项目：核对企业登记');
  writeWorkpaper(refreshed,'analysis','补充核对注册资本与实缴情况');
  refreshed.click('v2Action','open-draft',second);assert.equal(refreshed.run('state.project'),2);assert.equal(refreshed.nodes.get('workpaper-facts').value,'启明项目：核对投资主体');
  for(const [project,included,excluded] of [[0,first,second],[2,second,first]]) {
    refreshed.run(`state.project=${project};navigate('delivery')`);
    const html=refreshed.nodes.get('app').innerHTML;
    assert(html.includes(`data-id="${included}"`));assert(!html.includes(`data-id="${excluded}"`));
  }
  const again=harness(refreshed.saved());again.run("navigate('tasks')");
  assert(again.nodes.get('app').innerHTML.includes(`data-id="${first}"`));assert(again.nodes.get('app').innerHTML.includes(`data-id="${second}"`));
  again.click('v2Action','open-draft',first);assert.equal(again.nodes.get('workpaper-analysis').value,'补充核对注册资本与实缴情况');
});

test('disabled selected enterprise skill cannot start a draft or fall back to contract', () => {
  const h=harness();h.click('skillAction','prompt','enterprise-check');h.click('skillAction','toggle','enterprise-check');h.run("navigate('home')");
  const before=h.run('v2.customDrafts.length');h.click('action','send');
  assert(h.nodes.get('overlay').innerHTML.includes('该技能已停用'));
  assert(!h.nodes.get('overlay').innerHTML.includes('create-custom-draft'));
  assert.equal(h.run('v2.customDrafts.length'),before);assert.equal(h.run('state.route'),'home');
  assert.notEqual(h.run('state.target'),'contract');
});


function openScenario(h,id) { h.click('launchAction','open',id); }
function createScenarioDraft(h,id,project=0) {
  h.run(`state.project=${project}`);openScenario(h,id);
  h.click('launchAction','example',id);h.click('launchAction','preview',id);h.click('launchAction','apply',id);h.click('action','send');
  assert(h.nodes.get('overlay').innerHTML.includes('确认工作计划'),id+' needs its scenario plan');
  assert(h.nodes.get('overlay').innerHTML.includes(`data-id="scene-${id}"`));
  h.click('v2Action','create-custom-draft','scene-'+id);
  return h.run('v2.activeDraftId');
}
function workpaperAction(h,action,extra={}) { h.click('workpaperPlusAction',action,'',{draftId:h.run('v2.activeDraftId'),...extra}); }
function captureDownloads(h) { h.run('window.downloads=[];saveFile=(filename,content,type)=>window.downloads.push({filename,content,type})'); }

test('36 legal scenarios hydrate 45 distinct skills and retain editable method metadata', () => {
  const h=harness();const scenes=JSON.parse(h.run('JSON.stringify(window.LEGAL_SCENARIOS)'));
  const skills=JSON.parse(h.run('JSON.stringify(window.LegalSkills.all())'));
  assert.equal(scenes.length,36);assert.equal(skills.length,45);assert.equal(new Set(skills.map(s=>s.id)).size,45);
  for(const scene of scenes) {
    const method=skills.find(s=>s.id==='scene-'+scene.id);assert(method,scene.id);
    assert.equal(method.templateId,scene.id);assert(method.steps.length&&method.checks.length,scene.id+' requires a method and quality criteria');
    assert.deepEqual(method.tools,scene.tools);assert(method.inputs.includes(scene.fields[0].label));
  }
  assert(skills.some(s=>s.category==='企业法务'));
  configureSkill(h,'scene-criminal-interview');const refreshed=harness(h.saved());
  assert.equal(refreshed.run("window.LegalSkills.get('scene-criminal-interview').instructions"),'检查付款、验收与附件。保留缺口并人工复核。');
  assert.equal(refreshed.run("window.LegalSkills.get('scene-criminal-interview').templateId"),'criminal-interview');
  assert.equal(refreshed.run('window.LegalSkills.all().length'),45);
});

test('viewing generated prompt does not freeze future parameter updates', () => {
  const h=harness(),id='criminal-interview';openScenario(h,id);
  const key=h.run("window.LegalLauncher.find('criminal-interview').fields[0].key");
  h.input('scene-field-'+key,'首次参数：财务主管甲');h.click('launchAction','preview',id);
  assert(h.nodes.get('scene-prompt').value.includes('首次参数：财务主管甲'));
  h.click('launchAction','pane','fields');h.input('scene-field-'+key,'修改参数：财务主管乙');h.click('launchAction','preview',id);
  assert(h.nodes.get('scene-prompt').value.includes('修改参数：财务主管乙'));
  assert(!h.nodes.get('scene-prompt').value.includes('首次参数：财务主管甲'));
  assert.equal(h.run("v2.launcher.drafts['criminal-interview'].manual"),false);
});

test('manual prompt edits survive field changes, separate scenarios and refresh', () => {
  const h=harness(),first='criminal-interview',second='civil-evidence';
  openScenario(h,first);h.click('launchAction','example',first);h.click('launchAction','preview',first);
  const manual='手动要求：只整理会见问题；事实等待核验。';h.input('scene-prompt',manual);
  h.click('launchAction','pane','fields');const key=h.run("window.LegalLauncher.find('criminal-interview').fields[0].key");
  h.input('scene-field-'+key,'新参数不得覆盖全文');h.click('launchAction','preview',first);assert.equal(h.nodes.get('scene-prompt').value,manual);
  h.click('launchAction','cancel');openScenario(h,second);h.click('launchAction','example',second);h.click('launchAction','preview',second);
  assert(!h.nodes.get('scene-prompt').value.includes(manual));assert(h.nodes.get('scene-prompt').value.includes('280万元'));
  h.click('launchAction','cancel');const refreshed=harness(h.saved());openScenario(refreshed,first);refreshed.click('launchAction','preview',first);
  assert.equal(refreshed.nodes.get('scene-prompt').value,manual);
  refreshed.click('launchAction','regenerate',first);assert(refreshed.nodes.get('scene-prompt').value.includes('新参数不得覆盖全文'));
  assert.notEqual(refreshed.nodes.get('scene-prompt').value,manual);
});

test('every scenario starts its own editable outputs without falling back to fixed contract replay', () => {
  const h=harness();const scenes=JSON.parse(h.run('JSON.stringify(window.LEGAL_SCENARIOS)'));
  for(const scene of scenes) {
    const id=createScenarioDraft(h,scene.id,2);
    assert.equal(h.run('state.route'),'skill-workbench',scene.id);assert.equal(h.run('state.project'),2,scene.id);
    assert.equal(h.run('v2.customDraft.templateId'),scene.id);assert.equal(h.run('v2.customDraft.id'),'scene-'+scene.id);
    assert.deepEqual(JSON.parse(h.run('JSON.stringify(v2.customDraft.workpaperPlus.documents.map(d=>d.title))')),scene.outputs);
    assert.equal(h.run('v2.customDraft.scenarioValues['+JSON.stringify(scene.fields[0].key)+']'),scene.fields[0].example);
    assert(h.nodes.get('app').innerHTML.includes(`data-wpp-workspace="${id}"`));
  }
  assert.equal(h.run('v2.customDrafts.length'),36);assert.equal(h.run('v2.taskRuns.length'),0,'no fixed workflow was replayed');
});

test('document workpaper demo preserves originals, quality checks and complete exports after refresh', () => {
  const h=harness();const id=createScenarioDraft(h,'criminal-interview');
  const original='用户原稿 <script>不会执行</script>：需核实会见手续。';
  const section=h.control({wppDraft:id,wppOutput:0,wppSection:0});section.value=original;h.emit('document','input',{target:section});
  const check=h.control({wppDraft:id,wppCheck:0});check.checked=true;h.emit('document','change',{target:check});
  workpaperAction(h,'load-demo');assert(h.nodes.get('app').innerHTML.includes('固定虚构演示底稿'));
  assert.equal(h.run('v2.customDraft.workpaperPlus.checked[0]'),undefined);
  captureDownloads(h);workpaperAction(h,'export-md');assert(h.run('window.downloads.at(-1).content').includes('固定虚构演示底稿'));
  assert(h.run('window.downloads.at(-1).content').includes('财务主管林某'));
  const refreshed=harness(h.saved());refreshed.click('v2Action','open-draft',id);workpaperAction(refreshed,'restore-demo');
  assert.equal(refreshed.control({wppDraft:id,wppOutput:0,wppSection:0}).value,original);
  assert.equal(refreshed.control({wppDraft:id,wppCheck:0}).checked,true);
  captureDownloads(refreshed);workpaperAction(refreshed,'export-md');workpaperAction(refreshed,'export-html');
  const exports=JSON.parse(refreshed.run('JSON.stringify(window.downloads)'));assert(exports[0].content.includes(original));
  assert(exports[0].content.includes('- [x]'));assert(exports[0].content.includes('会见后核查清单'));
  assert(exports[1].content.includes('&lt;script&gt;不会执行&lt;/script&gt;'));assert(!exports[1].content.includes('<script>不会执行</script>'));
  assert(exports.every(item=>item.content.includes('未运行模型')));
});

test('table workpaper edits, added rows and restored demo survive export', () => {
  const h=harness();const id=createScenarioDraft(h,'civil-evidence');
  const cell=h.control({wppDraft:id,wppOutput:0,wppRow:0,wppCol:0});cell.value='真实原稿材料 A | 待核';h.emit('document','input',{target:cell});
  workpaperAction(h,'add-row',{output:'0'});const rowCount=h.run('v2.customDraft.workpaperPlus.documents[0].rows.length');
  workpaperAction(h,'load-demo');assert(h.run('v2.customDraft.workpaperPlus.documents[0].rows[0][0]').includes('演示证据01'));
  workpaperAction(h,'restore-demo');assert.equal(h.run('v2.customDraft.workpaperPlus.documents[0].rows.length'),rowCount);
  assert.equal(h.control({wppDraft:id,wppOutput:0,wppRow:0,wppCol:0}).value,'真实原稿材料 A | 待核');
  workpaperAction(h,'select-output',{output:'1'});assert(h.nodes.get('app').innerHTML.includes('对方证据质证意见'));
  captureDownloads(h);workpaperAction(h,'export-md');assert(h.run('window.downloads.at(-1).content').includes('真实原稿材料 A \\| 待核'));
  assert(h.run('window.downloads.at(-1).content').includes('证据链与补证清单'));
});

test('MCP plus requires rechecking changed auth and stdio arguments before activation', () => {
  const h=harness();h.run("configureConnector('legal-search')");h.click('connectionPlusAction','test','legal-search');
  h.field('connection-auth','env');h.field('connection-env-name','LEGAL_MCP_TOKEN');h.click('connectionPlusAction','save','legal-search');
  assert.equal(h.run("connectorById('legal-search').enabled"),false);
  h.click('connectionPlusAction','test','legal-search');h.click('connectionPlusAction','save','legal-search');
  assert.equal(h.run("connectorById('legal-search').auth.envVar"),'LEGAL_MCP_TOKEN');
  h.run("configureConnector('legal-search')");h.field('connection-transport','stdio');h.field('connection-command','legal-mcp-server');h.field('connection-args','["--read-only"]');
  h.click('connectionPlusAction','test','legal-search');h.field('connection-args','["--project-only"]');h.click('connectionPlusAction','save','legal-search');
  assert.equal(h.run("connectorById('legal-search').transport"),'Streamable HTTP');
  h.click('connectionPlusAction','test','legal-search');h.click('connectionPlusAction','save','legal-search');
  const refreshed=harness(h.saved());assert.equal(refreshed.run("connectorById('legal-search').transport"),'stdio');
  assert.equal(refreshed.run("connectorById('legal-search').args[0]"),'--project-only');
  assert.equal(refreshed.run("connectorById('legal-search').endpoint"),'');
});

test('MCP imports remain disabled, unknown tools need manual selection and invalid batches are atomic', () => {
  const h=harness();const imported={id:'custom-regression',name:'测试资料库',transport:'Streamable HTTP',endpoint:'https://demo.example.test/mcp',scope:'current',tools:[['find_matter','检索事项']],allowed:['find_matter'],auth:{kind:'none'}};
  h.click('connectionPlusAction','import');h.field('connection-import-json',JSON.stringify({connections:[imported]}));h.click('connectionPlusAction','apply-import');
  assert.equal(h.run("connectorById('custom-regression').enabled"),false);assert.equal(h.run("connectorById('custom-regression').allowed.length"),0);
  h.click('skillAction','edit','contract');assert(h.nodes.get('overlay').innerHTML.includes('测试资料库'));
  h.run("configureConnector('custom-regression')");h.groups.get('connection-tool')[0].checked=true;h.click('connectionPlusAction','test','custom-regression');h.click('connectionPlusAction','save','custom-regression');
  assert.equal(h.run("connectionReady(connectorById('custom-regression'))"),true);
  const before=h.run('v2.connectors.length');h.click('connectionPlusAction','import');
  h.field('connection-import-json',JSON.stringify({connections:[{...imported,id:'custom-valid'},{...imported,id:'custom-invalid',token:'sensitive-value'}]}));h.click('connectionPlusAction','apply-import');
  assert.equal(h.run('v2.connectors.length'),before);assert(h.nodes.get('connection-import-status').textContent.includes('凭据'));
  const refreshed=harness(h.saved());assert.equal(refreshed.run("connectorById('custom-regression').allowed[0]"),'find_matter');
});


test('MCP editor persists metadata, tool contracts and explicit new-tool grants', () => {
  const h=harness();h.run("configureConnector('legal-search')");
  h.field('connection-name','本所法规研究');h.field('connection-description','带效力时间的法源检索');
  const list=[['search_laws','检索法律法规'],['find_guidance','检索指导性文件']];
  const schemas={search_laws:{type:'object',properties:{query:{type:'string'}},required:['query']},find_guidance:{type:'object',properties:{region:{type:'string'}},required:['region']}};
  h.field('connection-tools-json',JSON.stringify(list));h.field('connection-schemas-json',JSON.stringify(schemas));h.click('connectionPlusAction','apply-tools','legal-search');
  const checks=h.groups.get('connection-tool');assert.equal(checks.length,2);assert.equal(checks[0].checked,true);assert.equal(checks[1].checked,false,'New tools must not inherit a grant');
  checks[1].checked=true;h.click('connectionPlusAction','test','legal-search');h.click('connectionPlusAction','save','legal-search');
  const refreshed=harness(h.saved());assert.equal(refreshed.run("connectorById('legal-search').name"),'本所法规研究');
  assert.equal(refreshed.run("connectorById('legal-search').desc"),'带效力时间的法源检索');assert.equal(refreshed.run("connectorById('legal-search').allowed.includes('find_guidance')"),true);
  assert.equal(refreshed.run("connectorById('legal-search').inputSchemas.find_guidance.required[0]"),'region');
  refreshed.run("configureConnector('legal-search')");refreshed.click('connectionPlusAction','test','legal-search');
  refreshed.field('connection-name','未经复查的更名');refreshed.click('connectionPlusAction','save','legal-search');
  assert.equal(refreshed.run("connectorById('legal-search').name"),'本所法规研究');
});

test('MCP editor blocks invalid schemas and nonpersistent uppercase IDs', () => {
  const h=harness();h.run("configureConnector('legal-search')");
  h.field('connection-schemas-json',JSON.stringify({search_laws:{type:'object',properties:{query:{type:'string'}},required:['missing']}}));
  h.click('connectionPlusAction','test','legal-search');h.click('connectionPlusAction','save','legal-search');assert.equal(h.run("connectorById('legal-search').enabled"),false);
  const imported={id:'CUSTOM-A',name:'大写连接',transport:'Streamable HTTP',endpoint:'https://demo.example.test/mcp',scope:'current',tools:[['query','检索']],allowed:['query']};
  h.click('connectionPlusAction','import');h.field('connection-import-json',JSON.stringify({connections:[imported]}));h.click('connectionPlusAction','apply-import');
  assert.equal(h.run("!!connectorById('CUSTOM-A')"),false);assert(h.nodes.get('connection-import-status').textContent.includes('小写'));
});

test('workpaper snapshots preserve attached filenames and tool grants independently', () => {
  const h=harness();h.run("state.attachments=['客户材料.pdf'];state.project=2");const id=createEnterpriseDraft(h,2);
  assert.equal(h.run('v2.customDraft.attachments[0]'),'客户材料.pdf');assert(h.run('v2.customDraft.tools[0].allowed.length')>0);
  h.run("state.attachments.push('新任务材料.png');connectorById('enterprise').allowed=[];persistWorkspace()");
  const refreshed=harness(h.saved());refreshed.click('v2Action','open-draft',id);
  assert.equal(refreshed.run('v2.customDraft.attachments.length'),1);assert(refreshed.run('v2.customDraft.tools[0].allowed.length')>0);
  assert.equal(refreshed.run('v2.customDraft.tools[0].inputSchemas.company_profile.required[0]'),'company_name');
});


test('free-text scenario selection cannot inherit previous matter fields or context', () => {
  const h=harness();const previous=createScenarioDraft(h,'criminal-interview',0);
  h.run("v2.launcher.drafts['criminal-interview'].context={jurisdiction:'旧事项法域',position:'旧事项立场'};persistWorkspace()");
  const oldValues=JSON.parse(h.run('JSON.stringify(v2.customDraft.scenarioValues)'));
  assert(Object.keys(oldValues).length>0,'Previous matter must have populated fields');
  h.click('action','new');h.input('prompt','请为新客户准备刑事会见，事项信息另行提供。');h.click('action','send');
  h.click('launchAction','use-current','criminal-interview');h.click('v2Action','create-custom-draft','scene-criminal-interview');
  const current=h.run('v2.activeDraftId');assert.notEqual(current,previous);
  assert.equal(h.run('v2.customDraft.prompt'),'请为新客户准备刑事会见，事项信息另行提供。');
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(v2.customDraft.scenarioValues)')),{});
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(v2.customDraft.scenarioContext)')),{});
  assert.equal(h.run('v2.customDraft.scenarioExample'),false);
  const refreshed=harness(h.saved());refreshed.click('v2Action','open-draft',current);
  assert.deepEqual(JSON.parse(refreshed.run('JSON.stringify(v2.customDraft.scenarioValues)')),{});
  refreshed.click('v2Action','open-draft',previous);
  assert.deepEqual(JSON.parse(refreshed.run('JSON.stringify(v2.customDraft.scenarioValues)')),oldValues,'Historical matter fields must remain intact');
});

test('changed skill outputs create new deliverables without rewriting historical workpapers', () => {
  const h=harness(),scene='criminal-interview',skill='scene-'+scene;
  const original=createScenarioDraft(h,scene);const originalTitles=JSON.parse(h.run('JSON.stringify(v2.customDraft.workpaperPlus.documents.map(d=>d.title))'));
  const section=h.control({wppDraft:original,wppOutput:0,wppSection:0});section.value='历史会见底稿原文';h.emit('document','input',{target:section});
  h.click('skillAction','edit',skill);h.field('skill-config-outputs','自定义会见摘要；后续核查表');h.click('skillAction','save',skill);
  openScenario(h,scene);assert(h.nodes.get('overlay').innerHTML.includes('自定义会见摘要'));
  const changed=createScenarioDraft(h,scene);const expected=['自定义会见摘要','后续核查表'];
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(v2.customDraft.workpaperPlus.documents.map(d=>d.title))')),expected);
  assert.equal(h.run('v2.customDraft.outputs'),'自定义会见摘要；后续核查表');
  captureDownloads(h);workpaperAction(h,'export-md');assert(h.run('window.downloads.at(-1).content').includes('## 自定义会见摘要'));
  const refreshed=harness(h.saved());refreshed.click('v2Action','open-draft',original);
  assert.deepEqual(JSON.parse(refreshed.run('JSON.stringify(v2.customDraft.workpaperPlus.documents.map(d=>d.title))')),originalTitles);
  assert.equal(refreshed.control({wppDraft:original,wppOutput:0,wppSection:0}).value,'历史会见底稿原文');
  refreshed.click('v2Action','open-draft',changed);
  assert.deepEqual(JSON.parse(refreshed.run('JSON.stringify(v2.customDraft.workpaperPlus.documents.map(d=>d.title))')),expected);
});

test('scenario jurisdiction, position, date and audience enter prompts and independent snapshots', () => {
  const h=harness(),scene='civil-evidence';openScenario(h,scene);
  const context={jurisdiction:'中国内地 · 上海',position:'原告代理人',asof:'事实发生于 2025 年；核验截至 2026-09-22',audience:'合伙人复核 · 内部证据目录'};
  for(const [key,value] of Object.entries(context))h.input('scene-context-'+key,value);
  h.click('launchAction','preview',scene);
  for(const value of Object.values(context))assert(h.nodes.get('scene-prompt').value.includes(value));
  h.click('launchAction','apply',scene);h.click('action','send');h.click('v2Action','create-custom-draft','scene-'+scene);
  const id=h.run('v2.activeDraftId');assert.deepEqual(JSON.parse(h.run('JSON.stringify(v2.customDraft.scenarioContext)')),context);
  for(const value of Object.values(context))assert(h.run('v2.customDraft.prompt').includes(value));
  openScenario(h,scene);h.input('scene-context-position','另一事项的被告立场');h.click('launchAction','cancel');
  const refreshed=harness(h.saved());refreshed.click('v2Action','open-draft',id);
  assert.deepEqual(JSON.parse(refreshed.run('JSON.stringify(v2.customDraft.scenarioContext)')),context);
  assert(refreshed.nodes.get('app').innerHTML.includes('原告代理人'),'Workpaper should present its captured context');
});

test('scenario favorites persist, filter the library and can be removed durably', () => {
  const h=harness();openScenario(h,'civil-evidence');h.click('launchAction','favorite','civil-evidence');
  openScenario(h,'criminal-interview');h.click('launchAction','favorite','criminal-interview');
  const refreshed=harness(h.saved());refreshed.click('launchAction','library');refreshed.click('launchAction','library-business','favorites');
  const html=refreshed.nodes.get('overlay').innerHTML;
  assert(html.includes('data-id="civil-evidence"'));assert(html.includes('data-id="criminal-interview"'));
  const excluded=refreshed.run("window.LEGAL_SCENARIOS.find(s=>!['civil-evidence','criminal-interview'].includes(s.id)).id");
  assert(!html.includes('data-id="'+excluded+'"'));
  openScenario(refreshed,'civil-evidence');refreshed.click('launchAction','favorite','civil-evidence');
  const again=harness(refreshed.saved());assert.deepEqual(JSON.parse(again.run('JSON.stringify(v2.launcher.favorites)')),['criminal-interview']);
  again.click('launchAction','library');again.click('launchAction','library-business','favorites');
  assert(!again.nodes.get('overlay').innerHTML.includes('data-id="civil-evidence"'));
});

console.log(`\n${passed} passed; ${failed} failed. DOM/state checks only; browser visual QA is separate.`);
process.exitCode=failed ? 1 : 0;
