'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','legal-materials.js'),'utf8');
function sandbox(saved){
  const revoked=[],listeners={},windowListeners={};let renders=0,persisted='';
  const c={console,Date,Math,Map,Array,String,Number,Set,Promise,
    state:{project:0,attachments:saved?[]:['legacy.txt']},projects:[{id:'A',name:'A事项'},{id:'B',name:'B事项'}],v2:saved||{},
    document:{activeElement:null,body:{style:{overflow:''}},addEventListener:(type,fn)=>{(listeners[type]||=[]).push(fn)},getElementById:()=>null,querySelectorAll:()=>[],querySelector:()=>null},
    window:{addEventListener:(type,fn)=>{windowListeners[type]=fn}},
    URL:{createObjectURL:()=> 'blob:local-test-'+Math.random(),revokeObjectURL:u=>revoked.push(u)},
    persistWorkspace:()=>{persisted=JSON.stringify(c.v2)},render:()=>{renders++}
  };
  vm.createContext(c);vm.runInContext(source,c);
  return {c,api:c.window.LegalMaterials,revoked,listeners,windowListeners,get persisted(){return persisted},get renders(){return renders}};
}
const file=(name,text='',size=text.length,lastModified=123)=>({name,type:name.endsWith('.png')?'image/png':'text/plain',size,lastModified,slice:()=>({text:async()=>text})});
(async()=>{
const t=sandbox(),h=t.api.helpers;
assert.equal(t.api.taskSnapshot(0)[0].name,'legacy.txt');
assert.equal(h.kind('SCAN.JPEG'),'image');assert.equal(h.kind('evil.svg'),'unsupported');assert.equal(h.kind('notes.json'),'text');
assert(h.validateFile(file('image.png','',13*1024*1024),0));assert(h.validateFile(file('notes.txt','',3*1024*1024),0));assert(h.validateFile(file('notes.txt'),20));
assert.equal(h.escapeHTML('<script>"&'), '&lt;script&gt;&quot;&amp;');
await t.api.importFiles([file('evidence.md','<script>alert(1)</script> material-secret')],'A');
assert.equal(t.api.taskSnapshot(0).length,2);assert.equal(t.api.taskSnapshot(1).length,0);
assert(!t.persisted.includes('material-secret'));assert(!t.persisted.includes('<script>'));
const evidence=t.c.v2.materials.find(m=>m.name==='evidence.md');evidence.excerpt='人工摘录';evidence.locator='第 2 页';
await t.api.importFiles([file('evidence.md','new')],'A');assert.equal(t.api.taskSnapshot(0).length,3,'different file size creates a separate version');
await t.api.importFiles([file('evidence.md','<script>alert(1)</script> material-secret')],'A');assert.equal(t.api.taskSnapshot(0).length,3,'same metadata restores preview without duplication');
await t.api.importFiles([file('scan.png','',120)],'A');
const image=t.c.v2.materials.find(m=>m.name==='scan.png');assert(!t.persisted.includes('blob:'));assert(!t.persisted.includes('base64'));
assert.equal(t.api.remove(image.id,'B'),false,'cannot delete another project material');assert.equal(t.api.remove(image.id,'A'),true);assert.equal(t.revoked.length,1);
t.c.state.project=1;t.c.render();assert.equal(t.c.state.attachments.length,0);assert.equal(t.renders,1);
await t.api.importFiles([file('b.json','{"key":1}')],'B');assert.equal(t.c.state.attachments[0],'b.json');
t.c.state.project=0;t.c.render();assert(t.c.state.attachments.includes('evidence.md'));assert(!t.c.state.attachments.includes('b.json'));
const reload=sandbox(JSON.parse(t.persisted));assert.equal(reload.api.taskSnapshot(0).find(m=>m.id===evidence.id).excerpt,'人工摘录');assert(reload.api.panel().includes('预览未保留'));
assert.equal(reload.api.taskSnapshot(0)[0].contentStored,false);
const snap=t.api.taskSnapshot(0);snap[0].excerpt='do not mutate';assert.notEqual(t.api.taskSnapshot(0)[0].excerpt,'do not mutate');
const xss=sandbox({materials:[h.snapshotMaterial({id:'x',projectKey:'A',name:'<img src=x onerror=alert(1)>.txt',role:'参考'})]});assert(!xss.api.panel().includes('<img src=x'));assert(xss.api.panel().includes('&lt;img'));
const full=sandbox({materials:[]});await full.api.importFiles(Array.from({length:22},(_,i)=>file(`f${i}.txt`)),'A');assert.equal(full.api.taskSnapshot(0).length,20);
console.log('PASS: material validation, escaping, local-only preview, project isolation, reselect, removal, render sync, refresh persistence and limits');
})().catch(e=>{console.error(e);process.exitCode=1});
