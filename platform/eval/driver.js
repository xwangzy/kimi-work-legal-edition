window.kwl = (() => {
  const FIELDS = {"casefile": {"verb": "开始整理", "min": 1, "f": {"issues": ["已知争点（可空，用“；”或换行隔开）", "text"]}}, "casefile-deep": {"verb": "开始精读", "min": 1, "f": {"perspective": ["时间线的视角（可空）", "text"]}}, "issues": {"verb": "开始分析", "min": 0, "f": {"claims": ["拟主张或需应对的请求", "text"], "side": ["我方地位", "select"]}}, "case-analysis": {"verb": "开始分析", "min": 1, "f": {"goal": ["我方目标", "text"], "side": ["我方地位", "select"]}}, "amount": {"verb": "开始测算", "min": 0, "f": {"mode": ["要做的是", "select"], "items": ["计算项目", "multi"], "as_of": ["计算截止日", "date"], "rate": ["利率口径", "select"]}}, "pleading": {"verb": "开始起草", "min": 0, "f": {"court": ["拟受理法院", "text"]}}, "defense": {"verb": "开始起草", "min": 1, "f": {"received_on": ["收到起诉状副本的日期", "date"], "domicile": ["被告在境内有无住所", "select"], "stance": ["总体意见", "select"]}}, "appeal": {"verb": "开始起草", "min": 1, "f": {"ruling": ["不服的是", "select"], "served_on": ["判决书或裁定书的送达日期", "date"], "domicile": ["上诉人在境内有无住所", "select"], "scope": ["上诉范围", "select"]}}, "arbitration-app": {"verb": "开始起草", "min": 1, "f": {"institution": ["仲裁机构", "text"], "claims": ["仲裁请求", "text"]}}, "hearing-outline": {"verb": "开始准备", "min": 1, "f": {"hearing_on": ["开庭日期", "date"], "side": ["我方地位", "select"], "focus_points": ["争议焦点（可空）", "text"]}}, "preservation": {"verb": "开始起草", "min": 1, "f": {"stage": ["保全阶段", "select"], "amount": ["请求保全数额", "text"]}}, "enforcement": {"verb": "开始起草", "min": 1, "f": {"effective_on": ["法律文书生效日期", "date"], "due_on": ["履行期限最后一日（分期写最后一期）", "date"], "paid": ["对方已履行情况", "text"]}}, "cross-exam": {"verb": "开始起草", "min": 1, "f": {"side": ["我方地位", "select"], "proof_deadline": ["举证期限届满日", "date"], "hearing_on": ["开庭或证据交换日期", "date"], "extra": ["已知疑点", "text"]}}, "agency": {"verb": "开始起草", "min": 0, "f": {"focus_points": ["争议焦点", "text"]}}, "intake-lit": {"verb": "开始整理", "min": 1, "f": {"case_type": ["案件类型", "select"]}}, "procedure": {"verb": "开始核查", "min": 1, "f": {"claims": ["拟主张的请求", "text"], "side": ["我方地位", "select"]}}, "labor-apply": {"verb": "开始梳理", "min": 1, "f": {"situation": ["基本情况", "long"]}}, "labor-arb-application": {"verb": "开始起草", "min": 1, "f": {"side": ["我方地位", "select"], "claims": ["拟主张的请求（可空，会逐项核对漏项）", "text"]}}, "labor-arb-defense-lit": {"verb": "开始起草", "min": 1, "f": {"side": ["我方地位", "select"], "received_on": ["收到仲裁申请书副本的日期", "date"], "claims": ["对方请求（一句话即可）", "text"]}}, "research-lit": {"verb": "开始研究", "min": 0, "f": {"question": ["研究问题", "long"], "when": ["事件时点", "text"]}}, "legal-opinion": {"verb": "开始起草", "min": 0, "f": {"question": ["要回答的问题", "long"], "addressee": ["致送对象", "text"]}}, "citation-audit": {"verb": "开始核对", "min": 1, "f": {"when": ["事件时点", "text"]}}, "doc-revise": {"verb": "开始修改", "min": 1, "f": {"opinion": ["修改意见", "long"]}}, "demand-lit": {"verb": "开始起草", "min": 0, "f": {"letter_type": ["函件类型", "select"], "deadline": ["期限要求", "text"]}}, "contract-review": {"verb": "开始审查", "min": 1, "f": {"type": ["合同类型", "select"], "focus": ["重点关注", "multi"], "redline": ["同时出一份建议修订稿", "select"]}}, "redraft": {"verb": "开始重审", "min": 2, "f": {"focus": ["重点关注", "multi"]}}, "redraft-local": {"verb": "开始比对", "min": 2, "f": {}}, "redline-notes": {"verb": "开始撰写", "min": 0, "f": {"audience": ["给谁看", "select"]}}, "rules-from-template": {"verb": "开始整理", "min": 1, "f": {"basis": ["范本是什么（可空）", "text"]}}, "audience-pack": {"verb": "开始处理", "min": 1, "f": {}}, "contract-draft": {"verb": "开始起草", "min": 0, "f": {"type": ["合同类型", "select"], "points": ["交易要点", "long"]}}, "dd-list": {"verb": "开始列清单", "min": 0, "f": {"deal_type": ["交易类型", "select"], "focus": ["关注重点", "text"]}}, "dd-findings": {"verb": "开始整理", "min": 1, "f": {"deal_type": ["交易类型", "select"]}}, "corporate-resolutions": {"verb": "开始起草", "min": 0, "f": {"meeting": ["会议", "select"], "company_type": ["公司类型", "select"], "matters": ["拟议事项", "text"]}}, "closing-checklist": {"verb": "开始整理", "min": 1, "f": {"closing_date": ["预计交割日", "date"]}}, "research-deal": {"verb": "开始研究", "min": 0, "f": {"question": ["研究问题", "long"]}}, "intake": {"verb": "开始整理", "min": 1, "f": {"who": ["访谈对象角色", "text"]}}, "contract-review-inhouse": {"verb": "开始审核", "min": 1, "f": {"type": ["合同类型", "select"], "focus": ["重点关注", "multi"], "redline": ["同时出一份建议修订稿", "select"]}}, "rules-from-template-inhouse": {"verb": "开始整理", "min": 1, "f": {"basis": ["范本是什么（可空）", "text"]}}, "compliance-qa": {"verb": "开始答复", "min": 0, "f": {"question": ["问题", "long"], "background": ["业务背景", "text"]}}, "demand-inhouse": {"verb": "开始处理", "min": 1, "f": {"issue": ["履约节点或违约事项", "long"], "letter_type": ["函件类型", "select"]}}, "case-report-lit": {"verb": "开始撰写", "min": 1, "f": {"audience": ["汇报对象", "select"], "as_of": ["截至日期", "date"]}}, "case-report": {"verb": "开始撰写", "min": 1, "f": {"audience": ["汇报对象", "select"], "as_of": ["截至日期", "date"]}}, "labor-response": {"verb": "开始准备", "min": 1, "f": {"claim": ["员工请求", "text"], "received_on": ["收到申请书副本的日期", "date"], "hearing": ["仲裁开庭日", "date"]}}, "labor-arb-defense": {"verb": "开始起草", "min": 1, "f": {"received_on": ["收到仲裁申请书副本的日期", "date"], "claims": ["员工请求（一句话即可）", "text"]}}, "labor-termination": {"verb": "开始评估", "min": 1, "f": {"reason": ["解除理由", "select"]}}, "policy-review": {"verb": "开始审查", "min": 1, "f": {"policy_type": ["制度类型", "select"], "place": ["所在地", "text"]}}, "suit-received": {"verb": "开始核查", "min": 1, "f": {"doc_kind": ["收到的是", "select"], "received_on": ["收到日期", "date"]}}};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setVal = (el, v) => { const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const until = async (fn, ms = 15000, step = 250) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(step); } };
  const btn = (root, txt) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === txt);
  const pickOpt = async (startsWith) => { const o = await until(() => [...document.querySelectorAll('[role=option]')].find((x) => x.textContent.trim().startsWith(startsWith))); o.click(); await sleep(300); };
  async function createMatter(m) {
    location.hash = '#/matters'; await sleep(900);
    (await until(() => btn(document, '新建事项'))).click(); await sleep(600);
    const dlg = await until(() => document.querySelector('[role=dialog]'));
    const typeBtn = () => [...dlg.querySelectorAll('button[type=button]')][0];
    if (m.type) { typeBtn().click(); await sleep(300); await pickOpt(m.type); }
    const sBtn = [...dlg.querySelectorAll('button[type=button]')][1]; sBtn.click(); await sleep(300); await pickOpt(m.stance);
    setVal(dlg.querySelector('input[placeholder^="例如：甲公司股权转让"]'), m.title);
    if (m.client) setVal(dlg.querySelector('input[placeholder^="委托人"]'), m.client);
    if (m.counter) setVal(dlg.querySelector('input[placeholder^="多个以顿号"]'), m.counter);
    { const g = [...dlg.querySelectorAll('[role=radio]')].find((b) => b.textContent.trim().startsWith('一般')); if (g && g.getAttribute('aria-checked') !== 'true') g.click(); await sleep(300); }
    if (m.eventDate || m.region || m.asOf) {
      [...dlg.querySelectorAll('button')].find((b) => b.textContent.includes('更多设置')).click(); await sleep(400);
      if (m.eventDate) setVal(dlg.querySelector('input[placeholder^="如 2023-05"]'), m.eventDate);
      if (m.region) setVal(dlg.querySelector('input[placeholder^="如 上海市"]'), m.region);
      if (m.asOf) setVal([...dlg.querySelectorAll('input[type=date]')].at(-1), m.asOf);
      await sleep(300);
    }
    btn(dlg, '创建事项').click();
    await until(() => /#\/matter\/mat_/.test(location.hash));
    return location.hash.match(/mat_[0-9a-f-]+/)[0];
  }
  async function inject(paths) {
    const dt = new DataTransfer();
    for (const p of paths) { const r = await fetch('/kwl-testdocs/' + p.split('/').map(encodeURIComponent).join('/')); if (!r.ok) throw new Error('fetch ' + p + ' ' + r.status); const b = await r.blob(); dt.items.add(new File([b], p.split('/').pop(), { type: b.type || 'application/octet-stream' })); }
    const inp = await until(() => document.querySelectorAll('main input[type=file]')[0]);
    inp.files = dt.files; inp.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => (document.querySelector('main')?.innerText.match(/已添加/g) ?? []).length >= paths.length, 60000);
    return paths.length;
  }
  const lastDlg = () => [...document.querySelectorAll('[role=dialog]')].at(-1);
  // 当事人信息（D-224）：开始面板里的“现在填 / 修改”打开对话框，按 我方 / 对方 分组填；parties = [{ side, name?, kind?, role?, f: { 标签: 值 } }]
  async function fillParties(dlg, parties) {
    const entry = await until(() => dlg.querySelector('.ss-parties button'), 20000);
    entry.click(); await sleep(800);
    const pd = await until(() => { const d = lastDlg(); return d && d !== dlg && d.querySelector('.pi-group') ? d : null; });
    for (let i = 0; i < parties.length; i++) {
      const p = parties[i];
      let groups = [...pd.querySelectorAll('.pi-group')];
      if (!groups[i]) { [...pd.querySelectorAll('button')].find((b) => b.className.includes('pi-add')).click(); await sleep(400); groups = [...pd.querySelectorAll('.pi-group')]; }
      const g = groups[i];
      if (p.kind) { const k = [...g.querySelectorAll('[role=radio]')].find((b) => b.textContent.trim() === p.kind); if (k && k.getAttribute('aria-checked') !== 'true') { k.click(); await sleep(300); } }
      if (p.role) setVal(g.querySelector('input[aria-label="称谓"]'), p.role);
      if (p.name) setVal(g.querySelector('input[aria-label="名称"], input[aria-label="姓名"]'), p.name);
      await sleep(150);
      for (const [label, v] of Object.entries(p.f ?? {})) {
        if (label === '性别') { g.querySelector('[aria-label="性别"]').click(); await sleep(300); await pickOpt(v); continue; }
        const inp = g.querySelector(`input[aria-label="${label}"]`); if (!inp) throw new Error('no party field ' + label); setVal(inp, v); await sleep(120);
      }
    }
    btn(pd, '保存').click();
    await until(() => !document.body.contains(pd), 20000);
    await until(() => /已填/.test(dlg.querySelector('.ss-parties')?.innerText || ''), 20000);
    await sleep(800);
  }
  async function start(card, matterId, o = {}) {
    location.hash = '#/start/' + card + '/' + matterId; await sleep(1200);
    const dlg = await until(() => document.querySelector('[role=dialog]'));
    await until(() => dlg.querySelectorAll('input[type=checkbox][aria-label]').length >= (o.minDocs ?? o.docs?.length ?? 0), 15000);
    if (o.parties) await fillParties(dlg, o.parties);
    const docBoxes = () => [...dlg.querySelectorAll('.ss-docs input[type=checkbox][aria-label]')];
    if (o.docs) {
      // 只勾指定的材料，按给出的先后顺序勾（回稿比对要先上一稿、后回稿）
      for (const c of docBoxes()) if (c.checked) { c.click(); await sleep(120); }
      for (const d of o.docs) { const c = docBoxes().find((x) => (x.getAttribute('aria-label') || '').includes(d)); if (!c) throw new Error('no doc ' + d); if (!c.checked) c.click(); await sleep(150); }
    } else if (o.checkAll !== false) for (const c of docBoxes()) if (!c.checked) { c.click(); await sleep(80); }
    await sleep(300);
    const spec = (o.spec ?? FIELDS[card]).f;
    for (const [k, v] of Object.entries(o.fields ?? {})) {
      if (!spec[k]) throw new Error('卡上没有字段 ' + k);
      const [label, kind, more] = spec[k];
      if (more) { const m = dlg.querySelector('button.ss-more'); if (m && m.getAttribute('aria-expanded') !== 'true') { m.click(); await sleep(400); } }
      const field = [...dlg.querySelectorAll('.ss-field')].find((l) => l.querySelector('.ss-label')?.textContent.replace('*', '').trim() === label);
      if (!field) throw new Error('no field ' + k);
      if (kind === 'select') { field.querySelector('button').click(); await sleep(300); await pickOpt(v); }
      else if (kind === 'multi') { for (const x of v) { const c = [...field.querySelectorAll('button')].find((b) => b.textContent.trim() === x); if (!c) throw new Error('no option ' + x); if (c.getAttribute('aria-pressed') !== 'true') c.click(); await sleep(150); } }
      else if (kind === 'list') {
        const items = Array.isArray(v) ? v : [v];
        for (let i = 0; i < items.length; i++) {
          let inp = field.querySelector(`input[aria-label="${label}第 ${i + 1} 项"]`);
          if (!inp) { [...field.querySelectorAll('button')].find((b) => b.textContent.includes('加一项')).click(); await sleep(300); inp = await until(() => field.querySelector(`input[aria-label="${label}第 ${i + 1} 项"]`)); }
          setVal(inp, items[i]); await sleep(150);
        }
      }
      else setVal(field.querySelector('textarea,input'), v);
      await sleep(200);
    }
    if (o.brief) { const ta = [...dlg.querySelectorAll('textarea')].find((t) => t.getAttribute('aria-label') && t.getAttribute('aria-label') !== '补充要求' && !Object.values(spec).some((s) => s[0] === t.getAttribute('aria-label'))); if (!ta) throw new Error('no brief'); setVal(ta, o.brief); }
    if (o.extra) setVal(dlg.querySelector('textarea[aria-label="补充要求"]'), o.extra);
    await sleep(1800);
    const verb = (o.spec ?? FIELDS[card]).verb;
    const go = await until(() => { const b = btn(dlg, verb) || btn(dlg, '下一步：确认'); return b && !b.disabled ? b : null; }, 30000).catch(() => null);
    if (!go) throw new Error('start disabled: ' + dlg.innerText.slice(-300));
    go.click(); await sleep(1800);
    // 开始前确认：第一次用 AI 时记录客户授权（委托合同中的 AI 条款 + 出处，D-216 / D-225）
    for (let i = 0; i < 8 && !/#\/run\//.test(location.hash); i++) {
      const d2 = lastDlg();
      const ack = d2 && btn(d2, '我知道了，继续'); // 第一次用 AI 的说明（每台电脑一次）
      if (ack) { ack.click(); await sleep(2000); continue; }
      if (d2 && /开始前确认/.test(d2.innerText) && !/正在记录并开始|正在开始/.test(d2.innerText)) {
        if (/还有一个任务在进行/.test(d2.innerText)) throw new Error('matter busy');
        const rec = d2.querySelector('.authz-record');
        if (rec) {
          const k = [...rec.querySelectorAll('[role=radio]')].find((b) => b.textContent.includes(o.basisKind ?? '委托合同中的 AI 条款'));
          if (k && k.getAttribute('aria-checked') !== 'true') { k.click(); await sleep(400); }
          const ref = await until(() => rec.querySelector('input[aria-label="授权依据的出处"]'));
          if (!ref.value.trim()) setVal(ref, o.basisRef ?? '委托代理合同第 9 条');
          const sens = rec.querySelector('.authz-sensitive input[type=checkbox]'); if (sens && !sens.checked) sens.click();
          await sleep(500);
        }
        const b = btn(d2, '记录授权并开始') || btn(d2, '重新确认并开始') || btn(d2, '确认发起');
        if (b && !b.disabled) b.click();
        else if (i === 7) throw new Error('confirm disabled: ' + d2.innerText.slice(-300));
      }
      await sleep(2000);
    }
    return location.hash;
  }
  // 复核建议（D-223）：勾选“复核建议”区块里的意见（nos 为空＝全部），点“按勾选的意见修改”，再点“确认追问”
  async function reviewApply(run, mat, nos) {
    await open(run, mat); await sleep(1500);
    const sec = await until(() => document.querySelector('section[aria-label="复核建议"]'), 20000);
    for (const c of sec.querySelectorAll('input[type=checkbox]')) { const n = Number((c.getAttribute('aria-label') || '').match(/第 (\d+) 条/)?.[1]); if ((!nos || !nos.length || nos.includes(n)) && !c.checked) { c.click(); await sleep(150); } }
    const head = sec.querySelector('.review-sugg-title')?.textContent;
    const b = [...sec.querySelectorAll('button')].find((x) => x.textContent.startsWith('按勾选的意见修改')); if (!b || b.disabled) throw new Error('apply disabled');
    b.click();
    const ok = await until(() => { const x = btn(document.querySelector('main'), '确认追问'); return x && !x.disabled ? x : null; }, 60000);
    ok.click(); await sleep(3000);
    return [head, location.hash];
  }
  async function open(run, mat) { location.hash = '#/run/' + run + '/' + mat; await sleep(2500); return document.querySelector('main')?.innerText ?? ''; }
  async function plan(run, mat) { const t = await open(run, mat); const i = t.indexOf('请确认工作计划'); return i < 0 ? t.slice(0, 600) : t.slice(i, i + 6000); }
  async function approve(run, mat) { await open(run, mat); const b = await until(() => btn(document, '按这个计划开始'), 20000); b.click(); await sleep(1500); return document.querySelector('main')?.innerText.slice(0, 120); }
  async function question(run, mat) { const t = await open(run, mat); const i = t.search(/需要你回答|请回答|助手想问/); return i < 0 ? t.slice(0, 1500) : t.slice(i, i + 3000); }
  async function free(m, goal) {
    location.hash = '#/matter/' + m; await sleep(1500);
    (await until(() => btn(document.querySelector('main'), '发起任务'))).click(); await sleep(800);
    const ta = await until(() => document.querySelector('main textarea')); setVal(ta, goal); await sleep(600);
    const send = await until(() => [...document.querySelectorAll('main button')].find((b) => (b.getAttribute('aria-label') || b.textContent.trim()) === '发送' && !b.disabled)); send.click(); await sleep(2000);
    for (let i = 0; i < 4 && !/#\/run\//.test(location.hash); i++) { const d2 = document.querySelector('[role=dialog]'); if (d2) { const b = btn(d2, '开始') || btn(d2, '确认发起'); if (b) b.click(); } await sleep(1500); }
    return location.hash;
  }
  async function card(c) { const m = await createMatter(c.matter); if (c.files && c.files.length) await inject(c.files); const h = c.id === 'free' ? await free(m, c.goal) : await start(c.id, m, { minDocs: (c.files || []).length, fields: c.fields, extra: c.extra, spec: c.spec, parties: c.parties, brief: c.brief, ...(c.docs ? { docs: c.docs } : {}) }); return [c.id, m, h.match(/run_[0-9a-f-]+/)?.[0]]; }
  // 回答提问卡：picks 是选项文字片段；other 给“其他”里要写的话（可选）
  async function answer(run, mat, picks, other) {
    await open(run, mat); const main = document.querySelector('main');
    for (const t of picks) { const el = [...main.querySelectorAll('[role=radio], [role=checkbox]')].find((x) => x.textContent.includes(t)); if (!el) throw new Error('no option ' + t); el.click(); await sleep(250); }
    if (other) { const ta = main.querySelector('textarea'); if (ta) setVal(ta, other); await sleep(200); }
    const ok = btn(main, '确定'); if (!ok || ok.disabled) throw new Error('confirm disabled: ' + (main.innerText.match(/还有 \d 题未选/) || [''])[0]);
    ok.click(); await sleep(1800); return main.innerText.slice(0, 100);
  }
  // 论点提纲确认（起草类方法）：勾“同时确认事实”，点“确认并开始起草”
  async function outline(run, mat) {
    await open(run, mat); const main = document.querySelector('main');
    const cb = [...main.querySelectorAll('input[type=checkbox]')].find((c) => (c.closest('label')?.innerText || '').includes('同时确认')); if (cb && !cb.checked) cb.click(); await sleep(300);
    const b = [...main.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('确认并开始起草')); if (!b) throw new Error('no outline'); b.click(); await sleep(2000); return main.innerText.slice(0, 80);
  }
  return { createMatter, inject, start, free, sleep, until, open, plan, approve, question, card, answer, outline, reviewApply, fillParties };
})(); 'ok'
