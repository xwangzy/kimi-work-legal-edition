'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function harness(seed) {
  const data = new Map(seed || []), listeners = {}, nodes = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, {value:'',textContent:'',innerHTML:'',isConnected:true,focus(){}}); return nodes.get(id); };
  const context = {window:{}, paths:{spark:true,file:true,scale:true,folder:true}, skillsView:null,skillDetail:null,showSkillPicker:null,
    localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},
    document:{addEventListener:(type,fn)=>(listeners[type]||=[]).push(fn),querySelectorAll:()=>[]},
    $:selector=>node(selector), escapeHTML:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    icon:()=>'', pageHead:(_a,b,c,d)=>b+c+d,button:()=>'',toast:()=>{},record:()=>{},closeOverlay:()=>{},navigate:()=>{},
    modal:(_title,body,footer)=>{node('#overlay').innerHTML=body+footer;},
    render:()=>{node('#app').innerHTML=context.skillsView();},
    saveFile:(name,content,type)=>downloads.push({name,content,type}),
    v2:{connectors:[{id:'custom-database',name:'本所资料库'}]},state:{},
  };
  const downloads=[];
  vm.createContext(context);
  for(const name of ['legal-scenarios.js','legal-skills.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context,{filename:name});
  const click=(action,id='')=>{const target={closest:()=>({dataset:{skillAction:action,skillId:id}})};for(const fn of listeners.click||[])fn({target});};
  return {api:context.window.LegalSkills,click,node,data,downloads,context,input(id,value){for(const fn of listeners.input||[])fn({target:{id,value}});}};
}
const h=harness(),api=h.api,t=api.transfer;
const clone=x=>JSON.parse(JSON.stringify(x));
const pkg=clone(t.exportPackage(api.all()));
assert.equal(pkg.schemaVersion,1);
assert.equal(pkg.skills.length,45);
const valid=t.validatePackage(JSON.stringify(pkg),['files','legal-search','enterprise','browser','knowledge','documents']);
assert.equal(valid.ok,true,JSON.stringify(valid.errors));
assert.equal(valid.skills.length,45);
assert.equal(t.validatePackage('{').ok,false);
assert.equal(t.validatePackage({...pkg,schemaVersion:2}).ok,false);
assert.equal(t.validatePackage({...pkg,skills:[]}).ok,false);
for(const change of [x=>x.name=42,x=>x.id='../invalid',x=>x.tools=['bad dependency'],x=>x.instructions='',x=>x.steps=[{}],x=>x.enabled='yes',x=>x.name='x'.repeat(41),x=>x.token='secret']) {
  const invalid=clone(pkg);change(invalid.skills[0]);const result=t.validatePackage(invalid);
  assert.equal(result.ok,false);assert.equal(result.skills.length,0,'An invalid batch cannot partially import');
}
const duplicate=clone(pkg);duplicate.skills[1].id=duplicate.skills[0].id;assert.equal(t.validatePackage(duplicate).ok,false);
const single={...pkg,skills:[{...pkg.skills[0],tools:['files','custom-missing','custom-missing']}]};
const missing=t.validatePackage(single,['files']);assert.equal(missing.ok,true);assert.equal(missing.warnings.length,1);assert.equal(missing.skills[0].tools.length,2);
const copies=t.importCopies(missing.skills,['custom-fixed-1'],'fixed');assert.equal(copies[0].id,'custom-fixed-2');assert.equal(copies[0].enabled,false);assert.equal(copies[0].custom,true);
copies[0].steps.push('changed');assert(!missing.skills[0].steps.includes('changed'));
const c={...clone(api.get('contract')),custom:true,id:'custom-test',enabled:true};
const history=JSON.stringify(c),archived=t.archiveConfig(c,true);assert.equal(JSON.stringify(c),history);assert.equal(archived.enabled,false);assert.equal(archived.archived,true);
const restored=t.archiveConfig(archived,false);assert.equal(restored.enabled,true);assert.equal(restored.archived,false);
const disabled=t.archiveConfig({...c,enabled:false},true);assert.equal(t.archiveConfig(disabled,false).enabled,false);
assert.equal(t.archiveConfig(api.get('contract'),true).archived,false,'Preinstalled skills cannot be archived');
// Actual UI handlers: preview is read-only, confirmation adds one disabled copy.
h.click('import');h.node('#skill-import-json').value=JSON.stringify(single);const initial=JSON.stringify(api.get('contract'));
h.click('preview-import');assert.equal(api.all().length,45);assert(h.node('#overlay').innerHTML.includes('custom-missing'));
h.click('confirm-import');assert.equal(api.all().length,46);assert.equal(JSON.stringify(api.get('contract')),initial);
const imported=api.all().at(-1);assert(imported.custom);assert.equal(imported.enabled,false);assert(imported.tools.includes('custom-missing'));
h.click('export-json',imported.id);assert.equal(JSON.parse(h.downloads.at(-1).content).skills.length,1);
h.click('export-all');assert.equal(JSON.parse(h.downloads.at(-1).content).skills.length,46);
h.click('toggle',imported.id);assert.equal(api.get(imported.id).enabled,true);
h.click('archive',imported.id);assert.equal(api.get(imported.id).archived,false,'Confirmation is required before archive');
h.click('confirm-archive',imported.id);assert.equal(api.get(imported.id).enabled,false);assert.equal(api.get(imported.id).archived,true);
h.context.showSkillPicker();assert(!h.node('#overlay').innerHTML.includes(imported.id));
h.click('use',imported.id);assert.equal(api.get(imported.id).enabled,false,'Archived skills cannot be activated by use');
const reloaded=harness(h.data);assert.equal(reloaded.api.get(imported.id).archived,true);assert(reloaded.api.get(imported.id).tools.includes('custom-missing'));
reloaded.click('restore',imported.id);assert.equal(reloaded.api.get(imported.id).enabled,true);
reloaded.click('import');reloaded.node('#skill-import-json').value=JSON.stringify(duplicate);reloaded.click('preview-import');reloaded.click('confirm-import');assert.equal(reloaded.api.all().length,46);
// Catalog uses progressive disclosure without losing search / category coverage.
h.click('tab','library');assert.equal((h.node('#app').innerHTML.match(/class="skill-tile"/g)||[]).length,12);
h.click('more');assert.equal((h.node('#legal-skill-cards').innerHTML.match(/class="skill-tile"/g)||[]).length,24);
h.context.showSkillPicker();
assert(h.node('#overlay').innerHTML.includes('skill-picker-search'));
assert.equal((h.node('#overlay').innerHTML.match(/class="selection-row"/g)||[]).length,12);
h.click('picker-more');assert.equal((h.node('#skill-picker-results').innerHTML.match(/class="selection-row"/g)||[]).length,24);
const later=api.all().find((x,i)=>i>24&&x.enabled);h.input('skill-picker-search',later.name);
assert(h.node('#skill-picker-results').innerHTML.includes(later.id),'Picker searches the entire catalog, not just rendered items');
h.input('skill-picker-search','nonexistent-legal-skill');assert(h.node('#skill-picker-results').innerHTML.includes('没有匹配'));
reloaded.click('detail',imported.id);assert(reloaded.node('#overlay').innerHTML.includes('导出 JSON'));
reloaded.click('edit',imported.id);assert(reloaded.node('#overlay').innerHTML.includes('custom-missing（缺少连接）'));
console.log('PASS skill package validation, atomic import preview, immutable copies, dependency retention, exports, archive/restore persistence and progressive catalog');
