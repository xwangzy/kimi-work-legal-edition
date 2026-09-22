'use strict';
/* Structured, locally editable workpapers. No model, document parser or remote
   data source is executed by this module. Must load after legal-workspace.js. */
(() => {
  const originalWorkpaperView = customWorkpaperView;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const sceneFor = d => (window.LEGAL_SCENARIOS || []).find(s => s.id === d?.templateId);
  const stamp = () => new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
  const toolNames = {'files':'项目文件','legal-search':'法规与案例检索',enterprise:'企业信息查询',browser:'浏览器研究',knowledge:'本所知识库',documents:'文档处理'};
  const tableColumns = {
    '类案对照表':['争议焦点','案例与可核验来源','相同 / 不同事实','裁判理由与适用限制'],
    '我方证据目录':['编号与材料','来源 / 原件状态','待证事实与证明目的','证明力限制 / 补证'],
    '对方证据质证意见':['对方证据与目的','真实性 / 合法性','关联性与证明力','具体异议与核查动作'],
    '证据链与补证清单':['待证事实','已有证据与定位','缺口 / 冲突','补证动作与责任人'],
    '违约金分段测算表':['期间与日数口径','本金 / 已付抵扣','利率与公式','测算结果 / 待核参数'],
    '攻防争点图谱':['争点与提问角色','对方意见 / 模拟假设','我方回应及证据','薄弱点与补证'],
    '会见后核查清单':['待核事项','陈述来源','所需材料 / 调查动作','责任人与跟进状态'],
    '类案样本对照表':['裁判及来源','事实 / 情节可比性','刑罚与结果','纳入理由及限制'],
    '量刑情节证据表':['可能适用情节','已证 / 待证状态','证据位置与缺口','适用条件待核'],
    '卷宗与证据索引':['卷号 / 页码','材料名称与类型','证明对象','完整性 / 可读性'],
    '指控要素证据矩阵':['指控构成要件','支持证据 / 定位','相反证据 / 冲突','待核辩护方向'],
    '证据与引用核对表':['论证 / 引用','证据卷页或来源','核验状态','缺口与复核意见'],
    '请求项目清单':['请求项目','成立条件与待证事实','期间 / 时效','所需证据'],
    '金额测算与假设表':['请求与情景','期间 / 工资基数','公式 / 已付抵扣','金额及互斥项目'],
    '地方规则核验表':['规则名称 / 发布主体','效力及适用地域','相关条款 / 来源','本案适用条件'],
    '证据附件目录':['附件编号','名称与材料位置','对应请求 / 证明目的','原件与核验状态'],
    '和解决策对照表':['可选路径','适用前提与证据','费用组成 / 测算假设','授权与待决事项'],
    '资料需求清单':['主题与材料','期间 / 样本范围','提供部门 / 责任人','进度与补件触发条件'],
    '风险与条款映射表':['发现事项 / 来源','交割或估值影响','整改 / 条款工具','责任与待决事项'],
    '公告来源索引':['公告标题与日期','官方来源 / 链接','版本 / 更正关系','核查范围与状态'],
    '交易事件时间线':['日期 / 阶段','事件与证据','批准 / 交割状态','前提与待核事项'],
    '备选条文对照表':['争议条款 / 原文','首选条文','备选条文及交换条件','触发条件 / 待授权'],
    '交易里程碑时间表':['目标日期 / 阶段','事项与前置依赖','责任角色','完成凭证 / 延期风险'],
    '交割条件核对表':['交割条件','前置事项 / 依据','责任人 / 期限','状态 / 完成证据'],
    '授信文件风险表':['文件与条款定位','具体风险情形','依据 / 适用条件','修订或核查动作'],
    '增信核查矩阵':['担保类型 / 主体','范围 / 期间','决议登记及顺位','缺口 / 放款条件'],
    '条款与话术差异表':['销售表述 / 位置','对应保险条款','承诺差异与误解风险','建议措辞及留痕'],
    '材料责任矩阵':['材料 / 流程环节','前置条件与适用依据','负责角色','完成状态与缺口'],
    '适当性审查矩阵':['客户 / 产品项目','准入及匹配要求','实际证据 / 时点','缺口与后续动作'],
    '决策权限与程序表':['拟议事项 / 公司类型','审议机构与依据','回避 / 表决口径','前置材料与程序状态'],
    '履职义务与证据矩阵':['角色与具体义务','履职行为 / 证据','缺口与影响','待核 / 补救动作'],
    '申报判断分支表':['判断节点','事实 / 数据及来源','满足 / 不满足 / 未知','条件分支与补件'],
    '数据处理活动清单':['场景 / 字段 / 目的','处理角色及数据流','必要性 / 处理基础','保存 / 共享 / 待核'],
    '合规差距与依据表':['处理活动 / 位置','规则及核验来源','实际做法 / 差距','整改及验证要求'],
    '商业条件待决表':['商业条件','已确认约定 / 来源','待选方案','决策人与期限'],
    '逐条审查意见表':['原条款与位置','问题及触发情景','依据 / 风险分级','替换文本与待决项'],
    '履约风险与行动表':['约定义务 / 节点','实际进展与证据','偏差 / 归责待核','催告补救及行动'],
    '合同台账字段模板':['合同编号 / 名称','主体 / 责任人','金额 / 币种 / 税口径','有效期 / 来源 / 核验'],
    '里程碑与付款子表':['关联合同编号','节点 / 触发条件','日期 / 金额 / 币种','已付 / 状态 / 来源'],
    '事件证据与核查表':['具体事件 / 时间','来源与核实状态','员工解释 / 反向证据','制度依据与待核动作'],
    '方案条件与程序对照表':['组织调整路径','适用条件 / 限制','协商及法定程序','待人工决策事项'],
    '匿名成本测算表':['匿名编号 / 方案','工龄 / 基数 / 日期','项目公式 / 抵扣','金额 / 互斥 / 假设'],
    '应诉材料责任清单':['请求 / 所需材料','保管部门 / 原始来源','责任人与期限','取得 / 核验状态'],
    '账票申报差异表':['交易 / 所属期间','合同及账票记录','申报口径 / 差异','待核金额公式与参数'],
    '问题与证据对应表':['来函问题 / 要求','已确认事实','证据与缺口','负责部门 / 回复状态'],
    '业务流程风险矩阵':['业务节点与主体','具体行为 / 风险触发','依据 / 前提条件','调整方案及验证证据'],
    '方案调整对照表':['原业务流程','拟调整方案','影响 / 必备条件','决策与技术验证'],
    '解决路径对照表':['解决路径','权利及商业前提','成本 / 风险 / 假设','履行保障及授权'],
    '案件进展与风险附表':['事项与截至日期','文书依据 / 进展','诉请 / 测算及区别','风险 / 下步 / 责任人']
  };
  const docSections = {
    '首次会见提纲':[['会见手续与优先事项','待核会见手续、程序状态、健康及沟通需求。'],['自由陈述与事实核查','先记录开放式问题，再围绕任职权限、款项用途、授权审批和到案经过追问。'],['证据线索与权利保障','记录可核实材料、相关人员和需要了解的讯问程序事项，不预设答案。'],['结束确认与下一步','确认记录准确性、待核线索及后续动作，不承诺案件结果。']],
    '会见记录模板':[['会见基本信息','填写日期、地点、参与人及程序阶段；不填写未核实的信息。'],['当事人陈述','逐项区分亲历、转述和推测；可使用问答记录。'],['待核事项与材料线索','记录疑点、矛盾、线索来源及所需书证。'],['律师记录与后续动作','将事实记录和律师初步判断分开，注明责任人与期限。']],
    '起诉状内部草稿':[['当事人与受理要素','核对主体、身份和管辖；未知信息保留待填。'],['诉讼请求','逐项填写请求和金额，并与分段测算附表核对。'],['事实与理由','以已核实材料组织时间线，争议内容注明为主张。'],['附件与待确认事项','列证据目录、管辖和提交前需律师复核的事项。']],
    '辩护意见内部草稿':[['程序节点与辩护事项','填写提交对象、程序阶段及本次论证范围。'],['主位意见与证据','采用观点、卷页、法律依据及适用分析结构。'],['有条件的备位意见','明确适用前提，不将备位意见写成事实自认。'],['请求与待复核引用','列提出的请求、待补证事项与未核验的法源。']],
    '劳动仲裁申请书内部草稿':[['主体与管辖信息','填写申请人、被申请人、履行地及待核身份资料。'],['仲裁请求及计算口径','每项对应请求条件、金额附表和证据。'],['事实与理由','按劳动关系时间线填写，区分申请人主张与已核实事实。'],['附件与提交前检查','列附件、金额待核项及本地格式要求。']],
    '合同内部草稿':[['主体、标的与商业条件','从已确认条件填写主体、服务范围、价款及期限。'],['交付、验收与付款','约定可核对的触发条件、时间起点和通知方式。'],['责任、终止与专项条款','结合当前业务填写责任、终止、保密、数据或知识产权条款。'],['争议解决与附件','填写管辖或仲裁、送达、签署及附件关系；待谈内容明确占位。']],
    '催告函内部草稿':[['致送对象与合同背景','核对通知条款、送达地址、我方身份和合同信息。'],['履约事实与材料依据','只陈述经核实的履约偏差，争议原因分别说明。'],['催告请求、补救期限与权利保留','请求须在授权内；明确期限起点，不擅自宣布解除。'],['审核与送达安排','记录审核人、发送授权及送达跟踪计划；本页面不会发送函件。']],
    '管理层一页汇报':[['截至报告日的关键变化','仅填写有文书或记录依据的实质变化，并注明截止日。'],['争点、业务影响与金额口径','区分对方诉请、内部测算、已确认责任及会计判断。'],['管理层需要决定的事项','给出选项、决策依据、权限要求和所需时间。'],['下一步行动与责任','填写负责人、截止日、补证或程序动作；未知期限标待核验。']],
    '函复或投诉回应内部稿':[['回复对象、范围与期限','核对来函主体、文书性质和逐项问题。'],['逐问事实说明与证据','每个问题对应已确认事实及附件，未知部分列后续核查。'],['已完成与计划措施','两类状态分开填写，不把计划写成已完成整改。'],['附件、保密与内部审核','核对必要披露范围、附件版本及对外授权；此处仅为草稿。']],
    '庭审问答脚本':[['演练争点与已知事实','先限定现有证据，模拟假设单独标记。'],['法官及对方可能追问','围绕争点设计问题，区分已知答辩与假设。'],['我方回应与证据位置','填写回答框架、支持材料以及尚不能确认的内容。'],['演练发现与补证','记录不利事实、论证薄弱点和准备动作。']]
  };
  function schema(s, title, index) {
    const knownColumns = tableColumns[title];
    if (knownColumns || /表|矩阵|清单|目录|索引|时间线|路线图/.test(title)) {
      let columns = knownColumns;
      if (!columns && /时间|路线/.test(title)) columns = ['阶段 / 时间','事项与前置条件','责任角色','状态 / 完成证据'];
      if (!columns && /补证|证据|材料|来源/.test(title)) columns = ['事项 / 所需材料','证明目的 / 来源位置','已取得 / 待核状态','下一步与责任人'];
      if (!columns && /检查|核对|核查|验证/.test(title)) columns = ['核对项目','依据 / 适用前提','核验记录','缺口 / 下一步'];
      if (!columns && /行动|决策|整改|跟进/.test(title)) columns = ['事项及触发条件','拟采取动作 / 选项','责任人 / 所需授权','期限 / 验证凭证'];
      columns ||= ['具体事项','材料或依据 / 位置','判断前提与待核问题','处理动作 / 责任 / 期限'];
      return {id:'output-'+index,title,kind:/时间线|里程碑|路线图/.test(title)?'timeline':'table',columns,rows:Array.from({length:3},()=>columns.map(()=>'')),notes:''};
    }
    const sections = docSections[title] || (index === 0 ? [
      ['范围、立场与材料边界','结合事项信息说明本次'+title+'的目标、已读取材料与关键缺口。'],
      [s.steps[0], '填写与「'+s.title+'」相关的具体事实、原文或待核问题。'],
      [s.steps[1], '逐项记录工作过程；结论需有来源、适用前提及限制。'],
      [s.steps[2], '整理可以交由律师复核的内容、待决事项与后续动作。']
    ] : [
      ['适用范围与前提','说明「'+title+'」的使用范围、事实前提和已知缺口。'],
      [title+' · 核心内容','按「'+s.title+'」任务填写具体内容，保留材料位置和判断依据。'],
      ['待确认事项与后续动作','标明需律师确认、补充资料或授权的事项和责任人。']
    ]);
    return {id:'output-'+index,title,kind:'document',sections:sections.map(([label,hint])=>({label,hint,text:''}))};
  }
  function ensure(d,s) {
    if (!d.workpaperPlus || d.workpaperPlus.version !== 1 || !Array.isArray(d.workpaperPlus.documents)) {
      d.workpaperPlus={version:1,activeOutput:0,documents:(typeof d.outputs==='string'&&d.outputs.trim()?d.outputs.split(/[、；;\n]+/).map(x=>x.trim()).filter(Boolean):s.outputs).map((title,i)=>schema(s,title,i)),checked:{},savedAt:'',mode:'template',demoBackup:null};
    }
    const w=d.workpaperPlus;
    w.activeOutput=Math.max(0,Math.min(Number(w.activeOutput)||0,w.documents.length-1));
    w.checked ||= {};
    return w;
  }
  function active() {
    const d=v2.customDraft,s=sceneFor(d);
    return s?{d,s,w:ensure(d,s)}:null;
  }
  function save(d) {
    d.workpaperPlus.savedAt=stamp();
    const index=v2.customDrafts?.findIndex(x=>x.draftId===d.draftId);
    if(index>=0)v2.customDrafts[index]=d;
    v2.activeDraftId=d.draftId;
    persistWorkspace();
    const indicator=document.getElementById('wpp-save-status');
    if(indicator)indicator.textContent='已保存在本浏览器 · '+d.workpaperPlus.savedAt;
  }
  const action=(label,name,d,extra='',cls='')=>`<button type="button" class="wpp-button ${cls}" data-workpaper-plus-action="${name}" data-draft-id="${esc(d.draftId)}" ${extra}>${label}</button>`;
  const written=doc=>doc.kind==='document'?doc.sections.some(x=>x.text.trim()):doc.rows.some(row=>row.some(x=>x.trim()))||!!doc.notes?.trim();
  const priorRecords=d=>[['来源记录',d.sources],['原有分析记录',d.analysis],['原有下一步记录',d.next]].filter(([,value])=>typeof value==='string'&&value.trim());
  const priorPanel=d=>priorRecords(d).some(([title])=>title!=='来源记录')?`<section class="wpp-side-card"><h3>原有工作记录 <span>保留原文</span></h3>${priorRecords(d).filter(([title])=>title!=='来源记录').map(([title,value])=>`<details><summary>${esc(title)}</summary><p class="wpp-context-prompt">${esc(value)}</p></details>`).join('')}<p class="wpp-footnote">既有记录保留在此，可复制至对应成果继续整理。</p></section>`:'';
  const priorMarkdown=d=>priorRecords(d).length?'## 原有工作记录（保留原文）\n\n'+priorRecords(d).map(([title,value])=>'### '+title+'\n\n'+value).join('\n\n')+'\n\n':'';
  const priorHTML=d=>priorRecords(d).length?'<section><h2>原有工作记录（保留原文）</h2>'+priorRecords(d).map(([title,value])=>'<h3>'+esc(title)+'</h3><p class="pre">'+esc(value)+'</p>').join('')+'</section>':'';
  function editor(d,doc,idx){
    const attrs=`data-wpp-draft="${esc(d.draftId)}" data-wpp-output="${idx}"`;
    if(doc.kind==='document')return `<div class="wpp-document">${doc.sections.map((section,i)=>`<section class="wpp-doc-section"><label for="wpp-section-${idx}-${i}"><span>${String(i+1).padStart(2,'0')}</span>${esc(section.label)}</label><textarea id="wpp-section-${idx}-${i}" ${attrs} data-wpp-section="${i}" rows="5" placeholder="${esc(section.hint)}">${esc(section.text)}</textarea></section>`).join('')}</div>`;
    return `<div class="wpp-table-hint">${doc.kind==='timeline'?'按实际进展填写日期和前置条件；未确定的时间请标记待确认。':'逐行填写；材料位置、判断前提与缺口应保留在同一行。'}</div><div class="wpp-table-scroll"><table class="wpp-table"><thead><tr><th scope="col" class="wpp-row-number">#</th>${doc.columns.map(h=>`<th scope="col">${esc(h)}</th>`).join('')}<th scope="col" class="wpp-row-action"><span class="wpp-visually-hidden">行操作</span></th></tr></thead><tbody>${doc.rows.map((row,r)=>`<tr><th scope="row" class="wpp-row-number">${String(r+1).padStart(2,'0')}</th>${doc.columns.map((h,c)=>`<td><textarea ${attrs} data-wpp-row="${r}" data-wpp-col="${c}" aria-label="${esc(doc.title)} 第${r+1}行 ${esc(h)}" placeholder="${esc(h)}" rows="3">${esc(row[c]||'')}</textarea></td>`).join('')}<td class="wpp-row-action">${action('×','remove-row',d,`data-output="${idx}" data-row="${r}" aria-label="移除第${r+1}行"`,'wpp-remove-row')}</td></tr>`).join('')}</tbody></table></div><div class="wpp-table-actions">${action('+ 添加一行','add-row',d,`data-output="${idx}"`)}<span>每项均可编辑，保留原始依据后再作判断</span></div><label class="wpp-notes" for="wpp-notes-${idx}">口径、材料缺口与补充说明<textarea id="wpp-notes-${idx}" ${attrs} data-wpp-notes="true" rows="3" placeholder="例如：材料尚未读取；金额暂按什么口径；哪些事实仍待核实。">${esc(doc.notes||'')}</textarea></label>`;
  }
  function toolsPanel(d,s){
    const snapshot=Array.isArray(d.tools)?d.tools:s.tools;
    return `<section class="wpp-side-card"><h3>工具快照 <span>创建时配置</span></h3><div class="wpp-tool-list">${snapshot.map(t=>{const item=typeof t==='string'?{id:t,name:toolNames[t]||t}:t;return `<div><span class="wpp-tool-dot"></span><b>${esc(item.name||toolNames[item.id]||item.id||'工具')}</b><small>${item.ready?'模拟可用':'未连接 / 待配置'}</small></div>`;}).join('')||'<p>本次未配置工具。</p>'}</div><p class="wpp-footnote">本工作区未调用模型、解析文件或查询外部数据。</p></section>`;
  }
  function view(d,s){
    const w=ensure(d,s),doc=w.documents[w.activeOutput],checks=Array.isArray(d.checks)&&d.checks.length?d.checks:s.checks,steps=Array.isArray(d.steps)&&d.steps.length?d.steps:s.steps;
    const done=checks.filter((_,i)=>w.checked[i]).length;
    const values=d.scenarioValues||{};
    const info=s.fields.map(f=>[f.label,values[f.key]]).filter(([,value])=>typeof value==='string'&&value.trim());
    const canDemo=['criminal-interview','civil-evidence'].includes(s.id);
    return `<div class="wpp-workspace" data-wpp-workspace="${esc(d.draftId)}"><header class="wpp-header"><div><div class="wpp-eyebrow">LEGAL WORKPAPER <span> / ${esc(s.area)}</span></div><h1>${esc(d.name||s.title)}</h1><p>${esc(d.projectName||'当前事项')} <span>·</span> ${esc(d.version||'v1.0')} <span>·</span> 内部工作底稿</p></div><div class="wpp-header-actions">${action('查看执行规则','instructions',d)}${action('下载 Markdown','export-md',d)}${action('下载 HTML','export-html',d,'','primary')}</div></header><div class="wpp-mode-banner ${w.mode==='demo'?'is-demo':''}"><span class="wpp-mode-icon">${w.mode==='demo'?'◈':'✎'}</span><div><strong>${w.mode==='demo'?'固定虚构演示底稿 · 可编辑体验':'工作结构已就绪，开始填写与复核'}</strong><p>${w.mode==='demo'?'下方内容是预置虚构案例，与本次输入的真实事项无关；未调用模型或检索。原稿已保存，可一键恢复。':'根据所选场景建立成果结构；背景来自你的输入。尚未运行模型或读取材料，不含自动生成的法律结论。'}</p></div>${w.demoBackup?action('恢复载入前原稿','restore-demo',d):canDemo?action('填入演示底稿','load-demo',d,'title="载入固定虚构样例，并备份当前底稿以供恢复"'):''}</div><div class="wpp-layout"><aside class="wpp-output-nav"><div class="wpp-nav-title">交付成果 <span>${w.documents.length}</span></div><div role="tablist" aria-label="成果目录" aria-orientation="vertical">${w.documents.map((x,i)=>`<button type="button" role="tab" aria-selected="${i===w.activeOutput}" aria-controls="wpp-editor-panel" id="wpp-tab-${i}" class="wpp-output-item ${i===w.activeOutput?'active':''}" data-workpaper-plus-action="select-output" data-draft-id="${esc(d.draftId)}" data-output="${i}"><span class="wpp-output-number">${String(i+1).padStart(2,'0')}</span><span><b>${esc(x.title)}</b><small>${written(x)?'已有编辑内容':'待填写结构'}</small></span><span class="wpp-output-arrow">›</span></button>`).join('')}</div><div class="wpp-nav-note"><span>工作方式</span><p>逐份完善成果，记录事实来源，再完成右侧质量核对。</p></div><div class="wpp-save-status" id="wpp-save-status" role="status">${w.savedAt?'已保存在本浏览器 · '+esc(w.savedAt):'编辑后自动保存到本浏览器'}</div></aside><main class="wpp-editor" id="wpp-editor-panel" role="tabpanel" aria-labelledby="wpp-tab-${w.activeOutput}"><div class="wpp-editor-heading"><span class="wpp-doc-tag">${doc.kind==='document'?'文书 / 提纲':doc.kind==='timeline'?'时间线 / 里程碑':'结构化工作表'}</span><h2>${esc(doc.title)}</h2><p>${esc(s.description)}</p></div>${editor(d,doc,w.activeOutput)}<footer class="wpp-editor-footer"><span>${w.mode==='demo'?'虚构样例 · 编辑后仍需律师核实':'模板结构 · 填写内容待律师复核'}</span><span>${w.activeOutput+1} / ${w.documents.length} 份成果</span></footer></main><aside class="wpp-context"><section class="wpp-side-card"><h3>事项信息 <span>本次输入</span></h3>${info.length?`<dl>${info.map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`:`<p class="wpp-context-prompt">${esc(d.facts||d.prompt||'本次尚未填写事项信息。')}</p>`}${d.sources?`<details><summary>来源记录</summary><p class="wpp-context-prompt">${esc(d.sources)}</p></details>`:''}${d.facts&&info.length?`<details><summary>事项背景原文</summary><p class="wpp-context-prompt">${esc(d.facts)}</p></details>`:''}</section><section class="wpp-side-card"><h3>执行步骤 <span>配置快照</span></h3><ol class="wpp-steps">${steps.map(x=>`<li>${esc(x)}</li>`).join('')}</ol></section><section class="wpp-side-card"><h3>质量核对 <span id="wpp-check-count">${done} / ${checks.length}</span></h3><div class="wpp-checks">${checks.map((x,i)=>`<label><input type="checkbox" data-wpp-check="${i}" data-wpp-draft="${esc(d.draftId)}" ${w.checked[i]?'checked':''}><span>${esc(x)}</span></label>`).join('')}</div><p class="wpp-footnote">勾选仅记录你的人工核对，不代表系统验证。</p></section>${materialsPanel(d)}${priorPanel(d)}${toolsPanel(d,s)}</aside></div></div>`;
  }
  customWorkpaperView=function(){const d=v2.customDraft,s=sceneFor(d);return s?view(d,s):originalWorkpaperView();};
  function documentMarkdown(doc){
    if(doc.kind==='document')return doc.sections.map(x=>`### ${x.label}\n\n${x.text||'［待填写］'}`).join('\n\n');
    const cell=x=>String(x||'［待填写］').replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>');
    return `| ${doc.columns.map(cell).join(' | ')} |\n| ${doc.columns.map(()=>'---').join(' | ')} |\n${doc.rows.map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n')}\n\n口径与补充说明：${doc.notes||'［待填写］'}`;
  }
  function materialText(d){return (d.materials||[]).map(m=>'- '+m.name+' · '+m.role+' · '+(m.locator||'定位待补充')+'\n  人工摘录：'+(m.excerpt||'未填写')+'\n  文件正文未随任务保存，未做 OCR 或自动分析。').join('\n\n')||((d.attachments||[]).join('、')||'未附材料');}
  function materialsPanel(d){return `<section class="wpp-side-card"><h3>材料与口径 <span>创建时快照</span></h3><p class="wpp-context-prompt">${esc(materialText(d))}</p>${Object.entries(d.scenarioContext||{}).filter(([,v])=>v).map(([key,v])=>`<p class="wpp-footnote">${esc(({jurisdiction:'法域与地域',position:'委托立场',asof:'事实与核验时间',audience:'交付要求'})[key]||key)}：${esc(v)}</p>`).join('')}</section>`;}
  function markdown(d,s,w){
    const values=s.fields.map(f=>`- ${f.label}：${d.scenarioValues?.[f.key]||'待填写'}`).join('\n');
    const checks=Array.isArray(d.checks)&&d.checks.length?d.checks:s.checks;
    return `# ${d.name||s.title}\n\n项目：${d.projectName||'当前事项'}\n\n技能版本：${d.version||'v1.0'}\n\n> ${w.mode==='demo'?'固定虚构演示底稿，与输入事项无关。':'场景工作结构，由用户编辑填写。'}未运行模型、解析文件或查询数据库；仅供内部工作及律师复核。\n\n## 事项信息（用户输入）\n\n${values}\n\n## 材料与人工摘录（创建时快照）\n\n${materialText(d)}\n\n## 事项口径\n\n${Object.values(d.scenarioContext||{}).filter(Boolean).join(" · ")||"待确认"}\n\n${d.facts?'事项背景：\n'+d.facts+'\n\n':''}${priorMarkdown(d)}${w.documents.map(doc=>'## '+doc.title+'\n\n'+documentMarkdown(doc)).join('\n\n')}\n\n## 人工质量核对\n\n${checks.map((x,i)=>`- [${w.checked[i]?'x':' '}] ${x}`).join('\n')}\n\n## 执行步骤（配置快照）\n\n${(d.steps?.length?d.steps:s.steps).map((x,i)=>`${i+1}. ${x}`).join('\n')}\n\n## 工具快照（未真实执行）\n\n${(d.tools||s.tools).map(t=>typeof t==='string'?'- '+(toolNames[t]||t):'- '+(t.name||t.id)+'：'+(t.ready?'模拟可用':'未连接 / 待配置')).join('\n')}\n`;
  }
  function htmlExport(d,s,w){
    const info=s.fields.map(f=>`<dt>${esc(f.label)}</dt><dd>${esc(d.scenarioValues?.[f.key]||'待填写')}</dd>`).join('');
    const documents=w.documents.map(doc=>`<section><h2>${esc(doc.title)}</h2>${doc.kind==='document'?doc.sections.map(x=>`<h3>${esc(x.label)}</h3><p class="pre">${esc(x.text||'［待填写］')}</p>`).join(''):`<table><thead><tr>${doc.columns.map(c=>'<th>'+esc(c)+'</th>').join('')}</tr></thead><tbody>${doc.rows.map(row=>'<tr>'+row.map(c=>'<td class="pre">'+esc(c||'［待填写］')+'</td>').join('')+'</tr>').join('')}</tbody></table><p class="pre">口径与补充说明：${esc(doc.notes||'［待填写］')}</p>`}</section>`).join('');
    const checks=(d.checks?.length?d.checks:s.checks).map((x,i)=>`<li>${w.checked[i]?'☑':'☐'} ${esc(x)}</li>`).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.name||s.title)} · 内部工作底稿</title><style>body{max-width:1060px;margin:48px auto;padding:0 32px;color:#24322e;font:15px/1.8 system-ui,sans-serif}h1{font-size:30px}h2{font-size:22px;border-bottom:1px solid #d9e3dd;padding-bottom:10px}h3{font-size:16px}section{margin:36px 0}.notice{background:#f3f6f2;border-left:3px solid #6d856d;padding:14px 20px}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px}td,th{border:1px solid #dce3dd;text-align:left;vertical-align:top;padding:12px;overflow-wrap:anywhere}th{background:#f3f6f2}.pre{white-space:pre-wrap;overflow-wrap:anywhere}dt{font-weight:650;margin-top:12px}dd{margin:0;white-space:pre-wrap}li{margin:7px 0}@media print{body{margin:0;max-width:none}section{break-inside:auto}h2,h3{break-after:avoid}tr{break-inside:avoid}}</style></head><body><p>Kimi Work · 法律行业版 / ${esc(s.area)}</p><h1>${esc(d.name||s.title)}</h1><p>${esc(d.projectName||'当前事项')} · ${esc(d.version||'v1.0')}</p><div class="notice">${w.mode==='demo'?'固定虚构演示底稿，与本次输入事项无关。':'场景工作结构，由用户编辑填写。'}未运行模型、解析文件或查询数据库；仅供内部工作及律师复核。</div><section><h2>事项信息（用户输入）</h2><dl>${info}</dl>${d.facts?'<p class="pre">'+esc(d.facts)+'</p>':''}</section><section><h2>材料与人工摘录（创建时快照）</h2><p class="pre">${esc(materialText(d))}</p><p>${esc(Object.values(d.scenarioContext||{}).filter(Boolean).join(" · ")||"事项口径待确认")}</p></section>${priorHTML(d)}${documents}<section><h2>人工质量核对</h2><ul>${checks}</ul><p>勾选仅记录人工核对，不代表系统验证。</p></section><section><h2>执行步骤与工具快照</h2><ol>${(d.steps?.length?d.steps:s.steps).map(x=>'<li>'+esc(x)+'</li>').join('')}</ol><ul>${(d.tools||s.tools).map(t=>'<li>'+esc(typeof t==='string'?(toolNames[t]||t):(t.name||t.id)+'：'+(t.ready?'模拟可用':'未连接 / 待配置'))+'</li>').join('')}</ul><p>本工作区未真实执行工具。</p></section></body></html>`;
  }
  function loadDemo(d,s,w){
    if(w.demoBackup||!['criminal-interview','civil-evidence'].includes(s.id))return;
    w.demoBackup={documents:clone(w.documents),checked:clone(w.checked),activeOutput:w.activeOutput,mode:w.mode};
    w.documents=s.outputs.map((title,i)=>schema(s,title,i));
    w.checked={};w.activeOutput=0;w.mode='demo';
    if(s.id==='criminal-interview'){
      const texts=[
        ['【虚构演示】涉嫌职务侵占的财务主管林某，拟进行首次会见。拘留日期、会见手续及具体程序状态均待核实。\n先询问是否有健康、用药或沟通上的即时需要；不要把家属说法作为当事人事实。','1. 请从你任职、负责的工作和审批权限讲起。\n2. 涉及的款项是什么业务？分别由谁申请、批准和支付？\n3. 哪些内容是你亲自经历，哪些是听他人说明？\n4. 你提到的垫付款对应哪些报销记录？\n5. 到案经过如何，相关时间或通知在哪里可以核实？','需要了解：公司审批制度、报销明细、银行流水、相关沟通的完整记录。\n开放询问讯问及权利保障情况，对回答如实记录。未取得材料前不评价案件证据是否充分。','复述关键回答，请当事人纠正记录。\n整理可核实线索，提交律师决定后续调查顺序。\n不承诺释放、无罪或处理期限。'],
        ['【虚构演示记录框架】\n日期、地点、会见人员：待填写\n涉嫌罪名及程序状态：待核实\n本样例没有真实会见发生。','以下只是记录方式演示，并非真实供述：\n问：款项与报销有何关系？\n答：当事人可能提出垫付款解释——此处须填写实际原话，不得沿用样例。\n信息属性：当事人陈述 / 亲历或转述待确认。','线索一：公司报销审批原件及附件。\n线索二：对应银行流水与收款主体。\n缺口：是否存在重复报销、授权范围及款项实际用途均未知。','律师复核：不得根据垫付款解释直接得出无罪判断。\n下一步：核查客观材料，保留支持及不支持该解释的证据。'],
      ];
      texts.forEach((group,i)=>group.forEach((text,j)=>{w.documents[i].sections[j].text=text;}));
      w.documents[2].rows=[['款项对应的业务及用途','虚构演示线索，事实未核实','核查报销单、审批附件、银行流水','案件律师 / 待确认'],['授权权限与制度版本','尚未取得公司文件','调取适用期间制度及任职授权','案件律师 / 待补材料'],['到案及程序状态','家属说明不能替代正式文书','核对通知文书及本人陈述','案件律师 / 待核']];
      w.documents[2].notes='固定虚构案例，仅演示记录结构。没有执行会见、阅卷或外部查询。';
    }else{
      w.documents[0].rows=[['演示证据01：购销合同','虚构样例；无实际文件 / 原件待核','拟证明交易关系及付款约定','签署主体、正文附件和具体付款条件待核验'],['演示证据02：送货单','虚构样例；12份中8份据称签收','拟证明货物交付及接收主体','未签收部分不能直接认定已交付；需其他证据补强'],['演示证据03：对账沟通','虚构样例；聊天完整性待核','拟证明往来金额确认过程','须确认账号主体、上下文、原始载体及是否附条件']];
      w.documents[1].rows=[['演示材料：质量异议邮件','发件主体、完整内容及形成时间待核','是否指向本案交付批次及约定质量标准待核','核对邮件上下文、异议时间及对应批次'],['演示材料：第三方检测报告','报告原件、检测主体与取样过程待核','检测样品与交付货物是否同一待核','核对样品来源、检测依据及范围'],['演示材料：退货单','签收人权限和原始凭证待核','涉及数量是否可与订单和送货单对应待核','核查退货接收、库存及价款冲减记录']];
      w.documents[2].rows=[['未签收部分是否实际交付','虚构送货记录，尚无正文','缺接收凭证与运输交接信息','核查物流签收和往来确认 / 责任人待定'],['对账金额是否包含争议退货','虚构聊天与退货线索','需核查对账截止、退货批次和抵扣','制作逐笔对照并复核原始材料 / 待办'],['检测结果是否关联本批货物','虚构检测报告线索','样品来源及批次对应不明','核查取样与封样记录 / 待补材料']];
      w.documents.forEach(doc=>doc.notes='以上为固定虚构演示数据，不来自当前事项。未读取文件；所列证明目的及疑问不能视为证据真实性、效力或案件结果的判断。');
    }
    save(d);render();toast('已载入固定虚构演示底稿，原稿可一键恢复');
  }
  document.addEventListener('input',e=>{
    const el=e.target;if(!el.dataset?.wppDraft||el.dataset.wppCheck!==undefined)return;
    const context=active();if(!context||context.d.draftId!==el.dataset.wppDraft)return;
    const {d,w}=context,doc=w.documents[Number(el.dataset.wppOutput)];if(!doc)return;
    if(el.dataset.wppSection!==undefined&&doc.kind==='document'&&doc.sections[Number(el.dataset.wppSection)])doc.sections[Number(el.dataset.wppSection)].text=el.value;
    else if(el.dataset.wppNotes!==undefined)doc.notes=el.value;
    else if(el.dataset.wppRow!==undefined&&doc.rows?.[Number(el.dataset.wppRow)]&&Number(el.dataset.wppCol)<doc.columns.length)doc.rows[Number(el.dataset.wppRow)][Number(el.dataset.wppCol)]=el.value;
    else return;
    save(d);
    const tab=document.getElementById('wpp-tab-'+el.dataset.wppOutput)?.querySelector('small');if(tab)tab.textContent=written(doc)?'已有编辑内容':'待填写结构';
  });
  document.addEventListener('change',e=>{
    const el=e.target;if(el.dataset?.wppCheck===undefined)return;
    const context=active();if(!context||context.d.draftId!==el.dataset.wppDraft)return;
    const {d,s,w}=context,checks=d.checks?.length?d.checks:s.checks,index=Number(el.dataset.wppCheck);
    if(!Number.isInteger(index)||index<0||index>=checks.length)return;
    w.checked[index]=!!el.checked;save(d);
    const count=document.getElementById('wpp-check-count');if(count)count.textContent=checks.filter((_,i)=>w.checked[i]).length+' / '+checks.length;
  });
  document.addEventListener('keydown',e=>{
    const el=e.target.closest('[data-workpaper-plus-action="select-output"]');
    if(!el||!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    const context=active();if(!context||context.d.draftId!==el.dataset.draftId)return;
    e.preventDefault();const {d,w}=context,n=w.documents.length;
    w.activeOutput=e.key==='Home'?0:e.key==='End'?n-1:(w.activeOutput+(e.key==='ArrowDown'?1:-1)+n)%n;
    save(d);render();document.getElementById('wpp-tab-'+w.activeOutput)?.focus();
  });
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-workpaper-plus-action]');if(!el)return;
    const context=active();if(!context||context.d.draftId!==el.dataset.draftId)return;
    const {d,s,w}=context,a=el.dataset.workpaperPlusAction,index=Number(el.dataset.output),doc=w.documents[index];
    if(a==='select-output'&&doc){w.activeOutput=index;save(d);render();document.getElementById('wpp-tab-'+index)?.focus();}
    else if(a==='add-row'&&doc?.rows){doc.rows.push(doc.columns.map(()=>''));save(d);render();}
    else if(a==='remove-row'&&doc?.rows){const row=Number(el.dataset.row);if(Number.isInteger(row)&&row>=0&&row<doc.rows.length){doc.rows.splice(row,1);if(!doc.rows.length)doc.rows.push(doc.columns.map(()=>''));save(d);render();}}
    else if(a==='instructions'){modal('本次执行规则',`<div class="wpp-rules"><p>技能版本：${esc(d.version||'v1.0')} · 创建时配置快照</p><pre>${esc(d.instructions||s.instructions)}</pre><h3>共同工作要求</h3><p>${esc(window.LEGAL_PROMPT_RULES||'')}</p></div>`,button('关闭','close'));}
    else if(a==='load-demo')loadDemo(d,s,w);
    else if(a==='restore-demo'&&w.demoBackup){const backup=w.demoBackup;w.documents=clone(backup.documents);w.checked=clone(backup.checked);w.activeOutput=backup.activeOutput;w.mode=backup.mode;w.demoBackup=null;save(d);render();toast('已恢复载入演示前的原稿');}
    else if(a==='export-md'||a==='export-html'){save(d);const name=(d.name||s.title).replace(/[\\/:*?"<>|]/g,'_')+'_工作底稿';saveFile(name+(a==='export-md'?'.md':'.html'),a==='export-md'?markdown(d,s,w):htmlExport(d,s,w),a==='export-md'?'text/markdown;charset=utf-8':'text/html;charset=utf-8');}
  });
})();
