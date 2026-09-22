'use strict';
/* Additional local-only MCP configuration. This module never calls a remote service or executes commands. */
(() => {
  const transports = ['Streamable HTTP','SSE','stdio'];
  const scopes = ['current','public','team'];
  const authKinds = ['none','oauth','env'];
  let checkedDraft = null;
  const buttonPlus = (label,action,id='',cls='') => `<button class="btn ${cls}" data-connection-plus-action="${action}" data-id="${escapeHTML(id)}">${label}</button>`;
  const fail = message => {throw new Error(message);};
  const secretKeys = /^(?:token|accessToken|refreshToken|access_token|refresh_token|apiKey|api_key|password|secret|clientSecret|client_secret|authorization|headers|env|environment)$/i;
  function rejectSecrets(value, path='配置') {
    if (Array.isArray(value)) return value.forEach((entry,i)=>rejectSecrets(entry,`${path}[${i}]`));
    if (value && typeof value === 'object') {
      for(const [key,item] of Object.entries(value)) {
        if(secretKeys.test(key)) fail(`${path} 含凭据字段 ${key}。仅可填写环境变量名称，请移除凭据内容。`);
        rejectSecrets(item,`${path}.${key}`);
      }
    } else if(typeof value === 'string' && (/(?:Bearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|access[_-]?token|token|password|client[_-]?secret)\s*[=:]\s*\S+)/i.test(value))) {
      fail(`${path} 疑似包含凭据；请改用环境变量名称。`);
    }
  }
  function cleanEndpoint(value) {
    const endpoint=String(value||'').trim();
    try {const u=new URL(endpoint);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error();}
    catch(_){fail('服务地址应为不含账号、查询参数与片段的 HTTP(S) URL。');}
    return endpoint;
  }
  // Demo contracts make each tool's expected inputs reviewable before enabling it.
  const toolContracts={
    list_files:{project_id:'项目标识',query:'文件名或类型关键词'},
    read_excerpt:{file_id:'文件标识',locator:'页码、条款或段落范围'},
    locate_source:{file_id:'文件标识',quote:'待定位的原文摘录'},
    search_laws:{query:'法律问题或条文关键词',jurisdiction:'适用法域',as_of:'效力核验日期 YYYY-MM-DD'},
    search_cases:{query:'争议焦点与关键事实',jurisdiction:'法院或地域范围',date_range:'裁判日期范围'},
    get_citation:{source_id:'法规或案例标识',locator:'引文位置'},
    company_profile:{company_name:'企业全称',credit_code:'统一社会信用代码（可空）'},
    shareholders:{company_name:'企业全称',as_of:'查询截至日期'},
    litigation_records:{company_name:'企业全称',query:'涉诉类型或关键词'},
    search_web:{query:'检索问题',domains:'优先来源域名，逗号分隔'},
    read_page:{url:'公开网页原始地址'},
    search_knowledge:{query:'规则或模板关键词',collection:'已授权知识集合'},
    get_template:{template_id:'模板标识',version:'所需模板版本'},
    parse_document:{file_id:'项目文件标识',mode:'正文、表格或图片 OCR'},
    export_document:{draft_id:'成果底稿标识',format:'导出格式：docx、pdf 或 markdown'}
  };
  for(const c of v2.connectors){
    if(c.inputSchemas)continue;
    c.inputSchemas=Object.fromEntries(c.tools.filter(([key])=>toolContracts[key]).map(([key])=>{
      const fields=toolContracts[key];return [key,{type:'object',properties:Object.fromEntries(Object.entries(fields).map(([name,description])=>[name,{type:'string',description}])),required:[Object.keys(fields)[0]],additionalProperties:false}];
    }));
  }
  const schemaFor = (c,key) => c.inputSchemas?.[key] || {type:'object',properties:{query:{type:'string',description:'按工具用途填写的检索或处理请求'}},additionalProperties:false};
  const snapshot = c => ({id:c.id,name:c.name,type:c.type,icon:c.icon,desc:c.desc,endpoint:c.endpoint||'',transport:c.transport||'Streamable HTTP',scope:c.scope||'current',tools:c.tools.map(t=>[t[0],t[1]]),allowed:[...c.allowed],auth:{kind:c.auth?.kind||'none',envVar:c.auth?.envVar||''},command:c.command||'',args:Array.isArray(c.args)?[...c.args]:[],inputSchemas:c.inputSchemas||{}});
  const fingerprint = c => JSON.stringify(snapshot(c));
  function validate(raw) {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('连接必须是一个配置对象。');
    rejectSecrets(raw);
    if(typeof raw.id!=='string'||!(/^(?:files|legal-search|enterprise|browser|knowledge|documents|custom-[a-z0-9-]+)$/.test(raw.id)))fail('连接 ID 必须是预置 ID 或 custom- 开头的小写字母、数字与连字符标识。');
    if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>100)fail('请填写 1–100 字的连接名称。');
    const transport=raw.transport||'Streamable HTTP';if(!transports.includes(transport))fail('不支持的传输方式。');
    const scope=raw.scope||'current';if(!scopes.includes(scope))fail('资料范围无效。');
    if(!Array.isArray(raw.tools)||!raw.tools.length||raw.tools.length>100)fail('连接需声明 1–100 项工具。');
    const seen=new Set();const tools=raw.tools.map(t=>{
      if(!Array.isArray(t)||t.length!==2||typeof t[0]!=='string'||!(/^[A-Za-z0-9_.-]{1,128}$/).test(t[0])||typeof t[1]!=='string'||!t[1].trim()||t[1].length>150||seen.has(t[0]))fail('工具需具有唯一名称和显示名称。');
      seen.add(t[0]);return [t[0],t[1].trim()];
    });
    if(!Array.isArray(raw.allowed)||raw.allowed.some(key=>typeof key!=='string'||!seen.has(key)))fail('白名单包含未声明工具，已拒绝导入。');
    const auth=raw.auth||{kind:'none',envVar:''};
    if(!auth||typeof auth!=='object'||Array.isArray(auth)||!authKinds.includes(auth.kind))fail('鉴权方案仅支持 none、oauth 或 env。');
    if(Object.keys(auth).some(k=>!['kind','envVar'].includes(k)))fail('鉴权配置仅可包含 kind 与 envVar。');
    const envVar=String(auth.envVar||'').trim();
    if(auth.kind==='env'&&!/^[A-Z_][A-Z0-9_]{0,99}$/i.test(envVar))fail('请填写有效环境变量名称，例如 LEGAL_MCP_TOKEN，不填写值。');
    const args=raw.args||[];if(!Array.isArray(args)||args.some(arg=>typeof arg!=='string'||arg.length>2000)||args.length>100)fail('启动参数须为字符串数组。');
    if(args.some(arg=>/^(?:--?)?(?:token|api[-_]?key|password|secret|authorization|header|env)(?:[=\s]|$)/i.test(arg)))fail('启动参数不能携带凭据选项，请使用环境变量名称。');
    const command=String(raw.command||'').trim();
    if(transport==='stdio'&&(!command||/[\r\n;&|`<>]/.test(command)||command.length>300))fail('请填写单个可执行文件名或路径，不使用 shell 命令串。');
    if(transport==='stdio'&&auth.kind==='oauth')fail('stdio 演示使用无鉴权或环境变量方案；OAuth 留给 HTTP 连接。');
    const inputSchemas=raw.inputSchemas||{};if(!inputSchemas||typeof inputSchemas!=='object'||Array.isArray(inputSchemas))fail('inputSchemas 必须是对象。');
    for(const [key,schema] of Object.entries(inputSchemas)){
      if(!seen.has(key)||!schema||typeof schema!=='object'||Array.isArray(schema)||schema.type!=='object')fail('输入 Schema 必须属于已声明工具，且 type 为 object。');
      if(schema.properties!==undefined&&(!schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties)))fail('Schema.properties 必须是对象。');
      if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some(k=>typeof k!=='string'||!Object.hasOwn(schema.properties||{},k))||new Set(schema.required).size!==schema.required.length))fail('Schema.required 须为已声明属性名组成的不重复数组。');
      if(schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=='boolean'&&(!schema.additionalProperties||typeof schema.additionalProperties!=='object'||Array.isArray(schema.additionalProperties)))fail('Schema.additionalProperties 须为布尔值或 Schema 对象。');
    }
    return {id:raw.id,name:raw.name.trim(),type:['法律数据','企业信息','项目资料','通用工具'].includes(raw.type)?raw.type:'通用工具',icon:paths[raw.icon]?raw.icon:'plug',desc:String(raw.desc||'自定义工具连接').slice(0,300),endpoint:transport==='stdio'?'':cleanEndpoint(raw.endpoint),transport,scope,tools,allowed:[...new Set(raw.allowed)],auth:{kind:auth.kind,envVar:auth.kind==='env'?envVar:''},command:transport==='stdio'?command:'',args:transport==='stdio'?args:[],inputSchemas};
  }
  function parseJSONField(id, fallback, message) {
    try { return JSON.parse($('#'+id)?.value || fallback); } catch (_) { fail(message); }
  }
  const toolChecks = c => c.tools.map(([key,label])=>`<label><input type="checkbox" name="connection-tool" value="${escapeHTML(key)}" ${c.allowed.includes(key)?'checked':''}><span><b>${escapeHTML(label)}</b><code>${escapeHTML(key)}</code></span></label>`).join('');
  function formValue(id) {
    const c=connectorById(id);if(!c)fail('连接已不存在。');
    const args=parseJSONField('connection-args','[]','启动参数请填写 JSON 字符串数组，例如 ["--read-only"]。');
    const tools=parseJSONField('connection-tools-json','[]','工具清单请填写 [["工具名","显示名称"]] 格式的 JSON 数组。');
    const inputSchemas=parseJSONField('connection-schemas-json','{}','工具输入 Schema 请填写合法 JSON 对象。');
    const declared=new Set(Array.isArray(tools)?tools.filter(Array.isArray).map(t=>t[0]):[]);
    return validate({...snapshot(c),name:$('#connection-name').value.trim(),desc:$('#connection-description').value.trim(),tools,inputSchemas,endpoint:$('#connection-endpoint').value.trim(),transport:$('#connection-transport').value,scope:$('#connection-scope').value,command:$('#connection-command').value.trim(),args,auth:{kind:$('#connection-auth').value,envVar:$('#connection-env-name').value.trim()},allowed:[...document.querySelectorAll('[name="connection-tool"]:checked')].map(el=>el.value).filter(key=>declared.has(key))});
  }
  function updateMode() {
    const transport=$('#connection-transport')?.value,auth=$('#connection-auth')?.value;
    const http=$('#connection-http-fields'),stdio=$('#connection-stdio-fields'),env=$('#connection-env-field'),oauth=$('#connection-oauth-note');
    if(http)http.hidden=transport==='stdio';if(stdio)stdio.hidden=transport!=='stdio';if(env)env.hidden=auth!=='env';if(oauth)oauth.hidden=auth!=='oauth';
  }
  configureConnector = function(id) {
    const c=connectorById(id);if(!c)return;checkedDraft=null;
    modal(escapeHTML(c.name)+' · 连接配置',`<div class="connector-config connection-plus">${pill('演示配置 · 无网络请求','blue')}<p class="config-intro">选择资料范围和工具。所有检查仅验证本地配置，stdio 命令不会执行。</p><div class="form-grid"><div class="field full"><label for="connection-name">连接名称</label><input id="connection-name" class="input" maxlength="100" value="${escapeHTML(c.name)}"></div><div class="field full"><label for="connection-description">用途说明</label><textarea id="connection-description" class="input" rows="2" maxlength="300">${escapeHTML(c.desc||'')}</textarea></div><div class="field"><label for="connection-transport">传输方式</label><select class="input" id="connection-transport">${transports.map(t=>`<option value="${t}" ${c.transport===t?'selected':''}>${t==='SSE'?'SSE（旧式 HTTP+SSE）':t}</option>`).join('')}</select></div><div class="field"><label for="connection-scope">资料范围</label><select class="input" id="connection-scope">${scopes.map(s=>`<option value="${s}" ${c.scope===s?'selected':''}>${scopeLabel(s)}</option>`).join('')}</select></div><div class="field full" id="connection-http-fields" ${c.transport==='stdio'?'hidden':''}><label for="connection-endpoint">服务地址</label><input class="input" id="connection-endpoint" value="${escapeHTML(c.endpoint||'')}" placeholder="https://service.example.test/mcp"><small>不包含凭据、查询参数或 URL 片段。</small></div><div class="field full" id="connection-stdio-fields" ${c.transport!=='stdio'?'hidden':''}><label for="connection-command">可执行文件</label><input class="input" id="connection-command" value="${escapeHTML(c.command||'')}" placeholder="例如：legal-mcp-server"><label for="connection-args">启动参数（JSON 数组）</label><textarea class="input" id="connection-args" rows="2">${escapeHTML(JSON.stringify(c.args||[]))}</textarea><small>仅保存启动配置；不会执行命令或读取环境变量。</small></div></div><details class="advanced-config" ${(c.auth?.kind&&c.auth.kind!=='none')?'open':''}><summary>鉴权方案</summary><div class="field"><label for="connection-auth">连接时的鉴权方式</label><select id="connection-auth" class="input">${[['none','无需鉴权'],['oauth','OAuth（仅记录方案）'],['env','环境变量（仅记录名称）']].map(([v,label])=>`<option value="${v}" ${(c.auth?.kind||'none')===v?'selected':''}>${label}</option>`).join('')}</select></div><div class="field" id="connection-env-field" ${c.auth?.kind!=='env'?'hidden':''}><label for="connection-env-name">环境变量名称</label><input class="input" id="connection-env-name" value="${escapeHTML(c.auth?.envVar||'')}" placeholder="LEGAL_MCP_TOKEN" autocomplete="off"><small>不填写实际 token、密码或密钥。</small></div><p class="small" id="connection-oauth-note" ${c.auth?.kind!=='oauth'?'hidden':''}>正式连接由客户端发起 OAuth 授权。此处不会跳转、登录或获取令牌。</p></details><div class="config-heading"><h3>允许调用的工具</h3><span>仅使用明确勾选的工具</span></div><div class="tool-checks" id="connection-tool-checks">${toolChecks(c)}</div><details class="advanced-config"><summary>编辑工具清单与输入 Schema</summary><p class="small">工具清单每行为 ["工具名", "显示名称"]。更新清单后，新工具默认不勾选；需手动选择并重新检查。</p><label class="field" for="connection-tools-json">工具清单（JSON）<textarea id="connection-tools-json" class="input" rows="6" spellcheck="false">${escapeHTML(JSON.stringify(c.tools,null,2))}</textarea></label><label class="field" for="connection-schemas-json">输入 Schema（按工具名配置）<textarea id="connection-schemas-json" class="input" rows="9" spellcheck="false">${escapeHTML(JSON.stringify(c.inputSchemas||{},null,2))}</textarea></label><p class="small">每个 Schema 的 type 必须为 object，且对应已声明工具。没有独立 Schema 的工具使用示例请求结构；均未经真实工具发现。</p>${buttonPlus('更新工具选择清单','apply-tools',id,'sm')}</details><div class="connection-test-result" id="connection-test-result" role="status">${icon('info')}请检查当前配置后再保存并启用。</div><div class="connection-plus-secondary">${buttonPlus('下载此连接 JSON','export-one',id,'quiet sm')}</div></div>`,(c.enabled?v2Button('停用连接','disable-connector',id,'quiet'):'')+buttonPlus('保存未启用配置','save-draft',id)+buttonPlus('检查配置','test',id)+buttonPlus('保存并启用','save',id,'primary'),true);
  };
  const originalConnectionsView=connectionsView;
  connectionsView=function(){return originalConnectionsView()+`<section class="connection-transfer"><div><h3>迁移连接配置</h3><p>导出不含凭据；导入后需检查工具白名单并重新测试。</p></div><div>${buttonPlus('导入 JSON','import','','sm')}${buttonPlus('下载全部配置','export-all','','sm')}</div></section>`;};
  function exportConfig(items) {return {format:'kimi-legal-connectors',version:1,demo:true,networkRequests:false,connections:items.map(snapshot)};}
  function parseImport(text) {
    if(text.length>500000)fail('配置文件过大，请限制在 500 KB 内。');
    let data;try{data=JSON.parse(text);}catch(_){fail('JSON 格式不正确。');}rejectSecrets(data);
    const items=Array.isArray(data)?data:data.connections;if(!Array.isArray(items)||!items.length||items.length>50)fail('请导入含 1–50 项 connections 的配置。');
    const seen=new Set();return items.map(raw=>{const c=validate(raw);if(seen.has(c.id))fail('导入文件包含重复连接 ID。');seen.add(c.id);const existing=connectorById(c.id);const known=new Set((existing?.tools||[]).map(t=>t[0]));const withheld=c.allowed.filter(key=>!known.has(key));return {...c,allowed:c.allowed.filter(key=>known.has(key)),enabled:false,tested:false,lastTest:'',importWithheld:withheld};});
  }
  function openImport(){modal('导入连接配置',`<div class="connection-plus"><p class="config-intro">导入后所有连接保持停用。新工具会保留在工具清单中，但需要你手动勾选才可启用。</p><label class="field">选择本地 JSON 文件<input type="file" id="connection-import-file" accept=".json,application/json"></label><label class="field">或粘贴 JSON<textarea class="input" id="connection-import-json" rows="12" spellcheck="false" placeholder='{"connections":[...]}'></textarea></label><div id="connection-import-status" role="status" class="small"></div></div>`,buttonPlus('校验并导入','apply-import','','primary'));}
  document.addEventListener('change',async e=>{
    if(['connection-transport','connection-auth'].includes(e.target.id))updateMode();
    if(e.target.id==='connection-import-file'){
      const f=e.target.files?.[0];if(!f)return;if(f.size>500000){toast('配置文件过大，请限制在 500 KB 内');return;}
      try{const contents=await f.text();if($('#connection-import-json'))$('#connection-import-json').value=contents;}catch(_){toast('无法读取配置文件，请重新选择或粘贴 JSON');}
    }
  });
  document.addEventListener('input',e=>{if(e.target.id?.startsWith('connection-')||e.target.name==='connection-tool'){checkedDraft=null;const result=$('#connection-test-result');if(result){result.classList.remove('passed');result.textContent='配置已修改，请重新检查后启用。';}}});
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-connection-plus-action]');if(!el)return;const a=el.dataset.connectionPlusAction,id=el.dataset.id;
    try{
      if(a==='apply-tools'){const c=formValue(id);$('#connection-tool-checks').innerHTML=toolChecks(c);checkedDraft=null;const r=$('#connection-test-result');r.classList.remove('passed');r.textContent='工具清单已更新。请勾选新工具，并重新检查后启用。';}
      if(a==='test'){const c=formValue(id);if(!c.allowed.length)fail('请至少选择一项工具后检查。');checkedDraft={id,fingerprint:fingerprint(c)};const r=$('#connection-test-result');r.innerHTML=`${icon('check')}本地格式检查通过 · ${c.allowed.length} 项工具 · 未验证服务器、命令或凭据`;r.classList.add('passed');}
      if(a==='save'||a==='save-draft'){
        const c=formValue(id);if(a==='save'&&(!c.allowed.length||checkedDraft?.id!==id||checkedDraft.fingerprint!==fingerprint(c)))fail('请先检查当前配置，修改后需要重新检查。');
        Object.assign(connectorById(id),c,{enabled:a==='save',tested:a==='save',lastTest:a==='save'?new Date().toLocaleString('zh-CN'):''});checkedDraft=null;persistWorkspace();record((a==='save'?'启用模拟连接：':'保存未启用连接：')+c.name);closeOverlay();render();toast(a==='save'?'模拟配置已启用，未建立真实连接':'配置已保存，连接保持停用');
      }
      if(a==='export-one'){const c=formValue(id);saveFile(c.name.replace(/[\\/:*?"<>|]/g,'_')+'_MCP.json',JSON.stringify(exportConfig([c]),null,2),'application/json');}
      if(a==='export-all')saveFile('法律工具连接_演示配置.json',JSON.stringify(exportConfig(v2.connectors),null,2),'application/json');
      if(a==='import')openImport();
      if(a==='apply-import'){
        const list=parseImport($('#connection-import-json').value);let withheld=0;
        for(const c of list){withheld+=c.importWithheld.length;const existing=connectorById(c.id);if(existing)Object.assign(existing,c);else v2.connectors.push(c);}
        checkedDraft=null;persistWorkspace();record(`导入 ${list.length} 项连接配置，均保持停用`);closeOverlay();render();toast(`已导入 ${list.length} 项，均未启用${withheld?`；${withheld} 项新工具待手动授权`:''}`);
      }
    }catch(error){toast(error.message||'配置处理失败，请检查输入');const status=$('#connection-import-status');if(status)status.textContent=error.message;}
  });
  // Read-only helpers support configuration validation and focused state tests.
  window.LegalConnectionsPlus={validate,parseImport,exportConfig};
})();
