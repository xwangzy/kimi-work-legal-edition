from pathlib import Path
import re, json, hashlib, os, unicodedata

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
BASE = ROOT / 'research/2026-10-21-智合AI调研'
TARGET = OUT / '00-智合AI功能与法律业务提示词-Skills-MCP完整手册.md'

def normal(s):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', s)).lower()

def rebase(path, text=None):
    text = path.read_text() if text is None else text
    def fix(m):
        label, raw = m.group(1), m.group(2).strip('<>')
        if raw.startswith(('http:', 'https:', '#', 'mailto:', 'codex:', '/')):
            return m.group(0)
        dest, sep, frag = raw.partition('#')
        relative = os.path.relpath((path.parent / dest).resolve(), OUT)
        return f'[{label}](<{relative}{sep}{frag}>)'
    return re.sub(r'\[([^\]]*)\]\(([^)]+)\)', fix, text)

def enhance_prompt(text, heading, addition):
    match = re.search(heading, text, re.M)
    assert match, heading
    start = text.index('```text', match.end())
    end = text.index('\n```', start + 7)
    return text[:end] + '\n' + addition + text[end:]

home = json.loads((OUT/'首页36预设-当日点读台账.json').read_text())['items']
scenes = json.loads((OUT/'工作台59预设-当日点读台账.json').read_text())['items']
market = json.loads((OUT/'技能市场316项-当日目录.json').read_text())['items']
skills = json.loads((BASE/'70项技能核验清单.json').read_text())['items']
extra_path = ROOT/'research/2026-10-22-补充40官方功能优化.md'
extra = re.findall(r'^## (\d{2})\. (.+)$',extra_path.read_text(),re.M)
assert (len(home), len(scenes), len(market),len(skills),len(extra)) == (36,59,316,70,40)
skill_names = {normal(s['name']):s for s in skills}
extra_names = {normal(name):(num,name) for num,name in extra}
community_no = 0
mapping = []
for item in market:
    label = next((x for x in item['labels'] if x in ('官方','社区','基础技能')), '待核')
    key = normal(item['title'])
    if label == '社区':
        community_no += 1
        route = f'community-C{community_no:03d}'
        method = f'C{community_no:03d} 原创场景方法'
    elif key in skill_names:
        s = skill_names[key]
        route = f'skill-{s["number"]:02d}'
        method = f'K{s["number"]:02d} · {s["id"]}'
    elif key in extra_names:
        num, _ = extra_names[key]
        route = f'official-{num}'
        method = f'O{num} 公开描述重构'
    else:
        route, method = 'coverage-review', '名称未匹配，见独立复核'
    mapping.append({**item,'source_label':label,'optimization_anchor':route,'method':method})
assert community_no == 206

inventory = ['# 逐项对应目录：95 个入口与 316 条市场记录\n',
 '观察日期：2026-10-23。H/S 是入口，K/O/C 是方法视图，M 是当日市场记录，WF 是专家工作流。存在包含、重名与复用关系，不能相加为独立功能数。本文逐条提供公开任务语义的原创重构；C 条目不代表取得社区内部 Skill 正文。\n',
 '## 首页 36 项\n','| 编号 | 业务领域 | 今日页面任务 | 优化正文 |','|---|---|---|---|']
for x in home:
    inventory.append(f'| {x["id"]} | {x["group"]}/{x["topic"]} | {x["title"]} | [查看](#{x["id"]}) |')
inventory += ['\n## 工作台 59 项\n','| 编号 | 身份 | 今日页面完整卡片名 | 优化正文 |','|---|---|---|---|']
for x in scenes:
    inventory.append(f'| {x["id"]} | {x["category"]} | {x["title"]} | [查看](#{x["id"]}) |')
inventory += ['\n## 市场 316 条与方法映射\n',
 '本日来源标签：105 官方、5 基础、206 社区；前13页各24条、第14页4条。大类统计为诉讼仲裁82、交易与非诉63、企业法务与合规25、法律研究与检索18、律所经营与个人执业13、通用办公29、娱乐减压7、未分类79。标题相同的条目仍按来源、作者和分页位置保留；没有可靠条目ID时不擅自合并。\n',
 '| 当日编号 | 页/位 | 页面标题 | 来源 | 作者 | 对应方法 |','|---|---|---|---|---|---|']
for x in mapping:
    title=x['title'].replace('|','\\|')
    author=x['author'].removeprefix('by ') or '页面未列'
    inventory.append(f'| {x["id"]} | {x["page"]}/{x["position"]} | {title} | {x["source_label"]} | {author} | [{x["method"]}](#{x["optimization_anchor"]}) |')
inventory_text='\n'.join(inventory)+'\n'
(OUT/'02-完整条目与优化对应索引.md').write_text(inventory_text.replace('](#','](00-智合AI功能与法律业务提示词-Skills-MCP完整手册.md#'))
(OUT/'市场316项-方法对应.json').write_text(json.dumps(mapping,ensure_ascii=False,indent=2)+'\n')

sections = [
 ('current','当日观察与设计裁决',OUT/'01-当日观察与产品裁决.md',None),
 ('index','95 场景与 316 市场条目的完整对应目录',OUT/'02-完整条目与优化对应索引.md',inventory_text),
 ('site-configuration','17 章产品模块、配置表单、MCP 与证据截图',OUT/'03-配置与MCP当日观察.md',None),
 ('modules','业务对象、材料、共享底稿与质量方法',BASE/'02-产品全景与重构方案.md','modules'),
 ('business','81 个法律业务任务模块与依赖',BASE/'子研究-法律业务全景.md','business'),
 ('homepage','首页 36 场景：优化提示词、Skill 组合与验收',BASE/'04-首页36场景优化提示词.md',None),
 ('workbench','工作台 59 场景：逐项优化提示词',BASE/'03-Skill工作台59场景优化提示词.md',None),
 ('open-skills','70 项公开 Skill：输入、输出、改进与执行指令',BASE/'05-官方70技能逐项优化.md',None),
 ('official-extra','额外 40 项官方展示功能：逐项优化',extra_path,None),
 ('experts','34 个公开专家工作流：编排与入口指令',BASE/'06-官方34专家工作流逐项优化.md',None),
 ('expert-qa','34 个专家各两项专属验收',ROOT/'research/2026-10-22-技能目录复核.md','expert-qa'),
 ('composite','组合交付与图片、OCR 等公共能力',BASE/'07-组合交付与公共能力提示词.md',None),
 ('execution','五项跨场景执行控制',ROOT/'research/2026-10-22-提示词独立复核.md','execution'),
 ('community-a','社区 C001—C103：逐项原创优化',OUT/'社区逐项优化-A.md',None),
 ('community-b','社区 C104—C206：逐项原创优化',OUT/'社区逐项优化-B.md',None),
 ('technical','Skills、MCP、接口 Schema、图片证据与评测',OUT/'调研-Skills与MCP设计.md',None),
 ('competitors','官方竞品核验与法律业务独立研究',OUT/'调研-法律业务与竞品.md',None),
 ('coverage-review','独立覆盖复核与修正',OUT/'独立复核-覆盖与提示词.md',None),
]
missing=[str(p.name) for _,_,p,_ in sections if not p.exists()]
if missing:
    print(json.dumps({'waiting_for':missing,'mapped_market_records':len(mapping)},ensure_ascii=False))
    raise SystemExit(2)

header='''# 智合 AI 功能与法律业务提示词、Skills、MCP 完整设计手册

研究日期：2026-10-23（Asia/Shanghai）。本文件合并全部详细方法，无须逐份子研究拼接。

**本日 computer use 逐项读取主站 36 项、工作台 59 项预设，逐页覆盖市场 316 条记录；结合固定开源 70 技能、34 专家、40 项额外官方展示功能，形成逐条原创优化和业务分层。** 两个 subagent 联网研究并分工重构 206 条社区场景，另一个 subagent 独立复核覆盖与提示词。

推荐主线：法律事项 → 工作阶段与目标 → 材料和事实 → 专业工序 → 工具 → 核验 → 律师审阅 → 履约与归档。卡片、Skill、专家、工具和市场记录是不同对象；文中的数量有包含和复用关系。

正文区分本日可见事实、历史研究、固定源码、厂商官方声明、原创建议。社区逐条优化依据可见名称与描述，没有取得其内部 Skill 正文；未公开后台系统提示词不作还原。所有优化、Schema 与验收标准属于设计文档，没有据此宣称 316 项技能已运行通过。

公开原文及许可：[70 项 MIT Skill 完整原文](<../2026-10-21-智合AI调研/70项技能原文合辑.md>)、[固定上游源码和资源](<../2026-10-21-智合AI调研/上游来源/legal-agent-skills/README.md>)。保留 `Copyright (c) 2026 John He (Decikingship)` 和 MIT 许可；许可证不附带数据库、API 或客户数据的访问权。

## 阅读路线

先读当日裁决与模块图，再按对应目录进入具体方法。法律使用者重点看 81 模块、95 入口与逐项交付验收；研发重点看 Skill/MCP 契约、执行控制与状态；经营和专业人员可按社区条目的作者、领域与任务消歧。

## 总目录

'''
parts=[header,'\n'.join(f'- [{title}](#{anchor})' for anchor,title,_,_ in sections),'\n']
sources=[]
for anchor,title,path,mode in sections:
    source=path.read_text()
    if mode=='modules':
        source=source[source.index('## 4. 按法律业务重排'):]
        source=source.replace('全部官方70项','固定开源70项')
    elif mode=='business':
        source=source[source.index('## 三、建议的信息架构'):source.index('## 十、对提示词质量')]
    elif mode=='expert-qa':
        source=source[source.index('## 4. 34 个专家'):]
    elif mode=='execution':
        source=source[source.index('## 4. 五项最值得补充'):]
    elif mode is not None:
        source=mode
    if source.startswith('# '):source=source.split('\n',1)[1]
    source=rebase(path,source)
    if anchor=='homepage':
        source=enhance_prompt(source,r'^## 11 .+$','把既定请求金额与独立复算并列：保留原数、计算前提、复算数、差额、原因与待确认人，不为匹配原数倒算参数或擅改诉请。页面示例172800元需与工龄和工资口径重新核对；未休年休假天数、加班时数等缺参不得从其他场景卡继承。')
        source=enhance_prompt(source,r'^## 25 .+$','核心团队竞业与服务期先按劳动关系、在职或离职后、股东或出让方交易义务分型。对劳动者离职后竞业，不照抄示例三年，核对法定期限、实际接触的保密信息、合理范围及补偿；培训服务期与违约金另核依据，不把所有义务并为一个条款。')
        source=re.sub(r'^(## (\d{2}) .+)$',lambda m:f'<a id="H{m.group(2)}"></a>\n\n{m.group(1)}',source,flags=re.M)
    if anchor=='workbench':
        source=enhance_prompt(source,r'^### S03 .+$','先建立主体全称、简称及合同甲乙方角色对照；原文中的义务人有歧义时保持待核，不能根据示例字母把维修等义务直接归给某家公司。')
        source=enhance_prompt(source,r'^### S24 .+$','核对每个步骤对实际交易结构、资产权利人及已签SPA条件是否适用；股权收购不自动等同资产过户，法定步骤、合同条件与建议安排分列。每条D+n绑定唯一基准事件，发现签署日与交割日冲突先列修正选择。')
        source=enhance_prompt(source,r'^### S39 .+$','权利告知按本案法域和阶段核验，分别解释如实回答、无关问题拒答、不得强迫自证其罪及笔录核对改正的具体规则，不照搬境外一般沉默权。程序侵害线索保留原话、时间和合法核查动作，不引导虚假陈述。')
        source=enhance_prompt(source,r'^### S43 .+$','页面标题“三路径”与副标题“四条路”不一致。以本任务实际纳入的路径和适用条件列清单，确认后再比较，不照抄数量或强行凑数。')
        source=enhance_prompt(source,r'^### S53 .+$','对“平分但某人多分20万元”先明确比较基准及逐人份额，核对合计、余额、处分权范围和替代安排；未经真实意愿确认不任选一种解释生成定稿。')
        source=enhance_prompt(source,r'^### S54 .+$','分别记录被继承人与继承人的国籍、惯常居所、所得税身份及美国遗产/赠与税domicile事实，字段不能互相替代。绿卡、开户地与资产税收所在地分别判断；境外证券账户先核实际资产和协定，未经当地法税核验不直接测税。')
        source=re.sub(r'^(### (S\d{2}) .+)$',lambda m:f'<a id="{m.group(2)}"></a>\n\n{m.group(1)}',source,flags=re.M)
    if anchor=='open-skills':
        source=re.sub(r'^(### (\d{2})\. .+)$',lambda m:f'<a id="skill-{m.group(2)}"></a>\n\n{m.group(1)}',source,flags=re.M)
    if anchor=='official-extra':
        source=re.sub(r'^(## (\d{2})\. .+)$',lambda m:f'<a id="official-{m.group(2)}"></a>\n\n{m.group(1)}',source,flags=re.M)
    if anchor in ('community-a','community-b'):
        source=re.sub(r'^(#{2,4} (C\d{3})[ |｜.、：:].+)$',lambda m:f'<a id="community-{m.group(2)}"></a>\n\n{m.group(1)}',source,flags=re.M)
    if anchor=='experts':
        source=re.sub(r'^(### (WF\d{2}) .+)$',lambda m:f'<a id="expert-{m.group(2)}"></a>\n\n{m.group(1)}',source,flags=re.M)
    historical=path.is_relative_to(BASE) or '2026-10-22' in str(path)
    note=''
    if historical:
        note='本章优化正文承接 2026-10-21/22 的工作区原创基线；本日重新点读与目录对应在前文。章节中的历史观察、来源日期和固定源码范围保留，法律规则需按具体事项时点核验；新增迁移纠偏以当日裁决和技术章为准。\n\n'
        source=source.replace('本轮','该基线研究').replace('本次已下载','该基线已下载')
    parts += [f'\n\n<a id="{anchor}"></a>\n\n# {title}\n\n',note,source]
    sources.append(str(path.relative_to(ROOT)))
TARGET.write_text('\n'.join(parts))
text=TARGET.read_text()
anchors=re.findall(r'<a id="([^"]+)">',text)
known=set(anchors)
local_broken=[]
for label,raw in re.findall(r'\[([^\]]*)\]\(([^)]+)\)',text):
    raw=raw.strip('<>')
    if raw.startswith('#'):
        if raw[1:] not in known:local_broken.append({'label':label,'target':raw})
    elif not raw.startswith(('http:','https:','mailto:','codex:')):
        f=raw.split('#')[0]
        if f and not (OUT/f).exists():local_broken.append({'label':label,'target':raw})
counts={
 'homepage_anchors':len([x for x in anchors if re.fullmatch('H\\d{2}',x)]),
 'workbench_anchors':len([x for x in anchors if re.fullmatch('S\\d{2}',x)]),
 'skills_anchors':len([x for x in anchors if re.fullmatch('skill-\\d{2}',x)]),
 'official_extra_anchors':len([x for x in anchors if re.fullmatch('official-\\d{2}',x)]),
 'expert_anchors':len([x for x in anchors if re.fullmatch('expert-WF\\d{2}',x)]),
 'community_anchors':len([x for x in anchors if re.fullmatch('community-C\\d{3}',x)]),
}
community_source='\n'.join((OUT/n).read_text() for n in ('社区逐项优化-A.md','社区逐项优化-B.md'))
community_headers=re.findall(r'^### (C\d{3})｜(.+)$',community_source,re.M)
community_prompts=re.findall(r'(?:```|~~~)text\n([\s\S]*?)\n(?:```|~~~)',community_source)
expected_community=[x for x in mapping if x['source_label']=='社区']
unknown_skill_ids=sorted(set(re.findall(r'(?<![a-z-])(?:core|lit|nonlit|util|zhihe)-[a-z][a-z0-9-]+',community_source))-{s['id'] for s in skills})
valid_modules=set(re.findall(r'^\| ([BLTCRK]\d{2}) ',(BASE/'子研究-法律业务全景.md').read_text(),re.M))
unknown_modules=sorted(set(re.findall(r'(?<![A-Z\d])([BLTCRK]\d{2})(?!\d)',community_source))-valid_modules)
community_title_mismatches=[i+1 for i,(a,b) in enumerate(zip(community_headers,expected_community)) if a[1]!=b['title']]
report={
 'date':'2026-10-23','timezone':'Asia/Shanghai','file':TARGET.name,
 'bytes':TARGET.stat().st_size,'characters':len(text),'lines':len(text.splitlines()),
 'sha256':hashlib.sha256(TARGET.read_bytes()).hexdigest(),
 'coverage':{'homepage':36,'workbench':59,'market':316,'official_labels':105,'foundation_labels':5,'community_labels':206,'public_skills':70,'public_experts':34,'additional_official_methods':40},
 'section_counts':counts,'duplicate_anchors':sorted({x for x in anchors if anchors.count(x)>1}),
 'broken_local_links':local_broken,'unmapped_market_records':[x['id'] for x in mapping if x['optimization_anchor']=='coverage-review'],
 'balanced_backtick_fences':len(re.findall(r'^```',text,re.M))%2==0,
 'balanced_tilde_fences':len(re.findall(r'^~~~',text,re.M))%2==0,
 'business_modules':len(valid_modules),
 'community_quality':{'cards':len(community_headers),'prompt_blocks':len(community_prompts),'unique_prompts':len(set(community_prompts)),'ids_contiguous':[x[0] for x in community_headers]==[f'C{i:03d}' for i in range(1,207)],'title_mismatches':community_title_mismatches,'unknown_reused_skill_ids':unknown_skill_ids,'unknown_reused_business_modules':unknown_modules},
 'sources':sources,
 'limits':['社区内部Skill正文未取得','316条未逐项运行','未连接真实MCP或检索API','未执行上游脚本','固定源码不代表今日线上最新版本'],
}
(OUT/'交付核查.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
