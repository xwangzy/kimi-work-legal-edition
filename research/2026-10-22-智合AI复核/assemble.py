from pathlib import Path
import re, json, hashlib, os

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
BASE = ROOT / 'research/2026-10-21-智合AI调研'

def read_rebase(path):
    text = path.read_text()
    def fix(m):
        label, target = m.group(1), m.group(2)
        if target.startswith(('https:', 'http:', '#', 'mailto:', 'codex:')):
            return m.group(0)
        raw = target.strip('<>')
        if raw.startswith('/'):
            return m.group(0)
        dest, sep, fragment = raw.partition('#')
        relative = os.path.relpath((path.parent / dest).resolve(), OUT)
        return f'[{label}](<{relative}{sep}{fragment}>)'
    return re.sub(r'\[([^\]]*)\]\(([^)]+)\)', fix, text)

sections = [
    ('current', '当日实测、范围与设计裁决', OUT/'01-当日实测与设计裁决.md'),
    ('delta', '提示词六项纠偏与五项执行控制', ROOT/'research/2026-10-22-提示词独立复核.md'),
    ('additional', '开源70以外的40项官方展示功能：逐项优化', ROOT/'research/2026-10-22-补充40官方功能优化.md'),
    ('expert-acceptance', '70技能静态复核与34专家的68条专属验收', ROOT/'research/2026-10-22-技能目录复核.md'),
    ('ecosystem', '203项社区记录的业务归并与原创方法家族', ROOT/'research/2026-10-22-社区生态业务归并.md'),
    ('comparison-update', '官方竞品补充研究与法律业务分层', ROOT/'research/legal_workflows.md'),
    ('mcp-update', 'Skills、MCP与工具契约补充研究', ROOT/'research/skills_mcp.md'),
]
missing = [str(p) for _,_,p in sections if not p.exists()]
if missing:
    raise SystemExit('等待子研究：' + ', '.join(missing))

header = '''# 智合 AI 法律业务功能、提示词、Skills 与 MCP 设计手册（2026-10-22 复核版）

研究日期：2026-10-22，Asia/Shanghai。本文件是完整合并稿，可直接查阅所有详细优化条目。它在工作区已有 2026-10-21 研究基础上，重新通过 computer use 逐项读取主站36个和工作台59个预设，逐页核查市场313条记录，并由两个子代理完成联网研究和独立复核。

**建议产品主线：以法律事项和工作阶段组织入口，复用经过版本管理的专业方法，通过可定位事实、可核验法源、可复算金额和可审阅文件完成交付。**

本版关键补充：市场的105条官方、5条基础与203条社区记录分开；公开仓库70项对应65条官方和5条基础，另40项官方展示功能逐项给出原创优化；补齐34位专家各两项专门验收。数量是不同层级的观察口径，不能相加宣传为独立能力总数。

内容性质分为：当日可见页面事实、固定公开源码、历史观察、厂商官方声明、研究者原创建议。预设点读和源码静态检查不等于业务已运行；没有取得的社区内部指令或隐藏系统提示不作还原。文中所有优化提示词、建议Schema和验收标准都需真实工具及法律样本验证后部署。

## 阅读路线

先读当日实测与设计裁决，再按业务选择详细提示词。研发可阅读MCP和执行控制章节；律师可按业务全景、36/59场景、70技能和34专家查找方法。全文保留来源与证据边界，避免把宣传、配置或演示回放当作已验证能力。

'''
nav = ['## 总目录\n']
for anchor,title,_ in sections:
    nav.append(f'- [{title}](#{anchor})')
nav += [
 '- [法律业务全景、95场景、70技能、34专家和公共能力详细库](#baseline-library)',
 '- [基线第一篇：产品模块与业务逻辑](#part-overview)',
 '- [基线第二篇：81个业务任务模块](#part-business)',
 '- [基线第三篇：首页36场景优化提示词](#part-home)',
 '- [基线第四篇：工作台59场景优化提示词](#part-scenes)',
 '- [基线第五篇：70项开源Skill逐项优化](#part-skills)',
 '- [基线第六篇：34项专家工作流逐项优化](#part-experts)',
 '- [基线第七篇：组合交付与图片/OCR等公共能力](#part-composite)',
 '- [基线第八篇：架构、契约与评测](#part-mcp)',
 '- [基线第九篇：竞品比较](#part-competitors)',
 '- [基线第十篇：10月21日历史观察台账](#part-evidence)',
]
parts = [header, '\n'.join(nav), '''

## 方法与业务对象的连接

```mermaid
flowchart TD
  A[案件、合同、交易、合规事项] --> B[阶段、目标、立场与材料]
  B --> C[可编辑场景提示词]
  C --> D[专家工作流：顺序、分支、交接]
  D --> E[Skill：可复用步骤与专门验收]
  E --> F[工具：解析、检索、计算、修订、导出]
  F --> G[草稿与底稿：事实、引用、版本和未决项]
  G --> H[律师审阅与后续授权动作]
  H --> I[跟踪、变更、归档和机构复用]
  I --> B
```

源码及历史完整原文保存在[固定上游资料](<../2026-10-21-智合AI调研/上游来源/legal-agent-skills/README.md>)和[70项MIT技能原文合辑](<../2026-10-21-智合AI调研/70项技能原文合辑.md>)。本手册主体承载优化与判断，不用未取得的内部指令冒充原文。
''']
# Explicitly map today's observed homepage titles to the existing original topic library.
observations = (BASE/'01-现场观察与覆盖台账.md').read_text()
table = observations.split('## 本轮主站36预设覆盖清单')[1].split('## Skill工作台59预设及开源范围')[0]
home_rows = []
for line in table.splitlines():
    if line.startswith('|') and not line.startswith(('|---','| 一级')):
        cells = [v.strip() for v in line.strip('|').split('|')]
        if len(cells) == 3:
            home_rows.append(cells)
home_titles = re.findall(r'^## (\d{2}) (.+)$',(BASE/'04-首页36场景优化提示词.md').read_text(),re.M)
workbench_titles = re.findall(r'^### (S\d{2}) (.+)$',(BASE/'03-Skill工作台59场景优化提示词.md').read_text(),re.M)
assert len(home_rows) == len(home_titles) == 36
assert len(workbench_titles) == 59
mapping = ['# 当日95个预设与优化稿映射\n',
'36项首页可见名称由既有台账承接，本轮逐卡核对；优化正文延续本项目原创主题，不称竞品逐字原文。59项使用语义识别名，页面空格、标点及营销副标题可不同。编号用于定位，不是新增能力计数。\n',
'## 首页36项\n','| 编号 | 页面可见任务 | 原创优化主题 | 定位 |','|---|---|---|---|']
for (num,topic),row in zip(home_titles,home_rows):
    mapping.append(f'| H{num} | {row[1]} | {topic} | [正文](00-完整手册.md#home-{num}) |')
mapping += ['\n## 工作台59项\n','| 编号 | 场景识别名 | 定位 |','|---|---|---|']
for num,topic in workbench_titles:
    mapping.append(f'| {num} | {topic} | [正文](00-完整手册.md#scene-{num}) |')
mapping_text='\n'.join(mapping)+'\n'
(OUT/'02-95场景对应索引.md').write_text(mapping_text)
parts.append('\n\n<a id="scene-index"></a>\n\n'+mapping_text.replace('(00-完整手册.md#','(#'))
for anchor,title,path in sections:
    parts.append(f'\n\n<a id="{anchor}"></a>\n\n# {title}\n\n')
    source = read_rebase(path)
    source = source.split('\n',1)[1] if source.startswith('# ') else source
    parts.append(source)

baseline = read_rebase(BASE/'00-智合AI法律业务功能与提示词Skills-MCP完整手册.md')
baseline = baseline[baseline.index('<a id="part-overview">'):]
# Keep the historical observation scope explicit, with current scope in the front chapters.
baseline = baseline.replace('全部官方70项', '固定开源70项')
baseline = re.sub(r'^(### (\d{2}) .+)$',lambda m:f'<a id="home-{m.group(2)}"></a>\n\n{m.group(1)}',baseline,flags=re.M)
baseline = re.sub(r'^(#### (S\d{2}) .+)$',lambda m:f'<a id="scene-{m.group(2)}"></a>\n\n{m.group(1)}',baseline,flags=re.M)
parts.append('''

<a id="baseline-library"></a>

# 详细方法库：2026-10-21基线与本次复核映射

以下内容来自工作区既有基线，保留其详细条目与引用，作为本版的完整业务方法库。此处“本轮”“现场”指10月21日；10月22日新增证据在前面的当日实测章。主站36个主题沿用本项目原创配置并与今天实际看到的36卡逐项对照，不能称为逐字提取的竞品提示词。59场景为可见任务语义的原创重构；70技能/34专家依据固定公开源码。市场105官方/5基础/203社区及新增40项优化按本版前文理解。

''')
parts.append(baseline)
target = OUT/'00-完整手册.md'
target.write_text('\n'.join(parts))

text = target.read_text()
relative_broken = []
for label,raw in re.findall(r'\[([^\]]*)\]\(([^)]+)\)',text):
    raw=raw.strip('<>')
    if raw.startswith(('http:', 'https:', 'mailto:', '#', 'codex:')):
        continue
    path=raw.split('#')[0]
    if path and not (OUT/path).exists():
        relative_broken.append({'label':label,'target':raw})
report={
 'date':'2026-10-22','timezone':'Asia/Shanghai',
 'scope':{'homepage_presets':36,'workbench_presets':59,'market_records':313,
 'market_official_labels':105,'market_foundation_labels':5,'market_community_labels':203,
 'fixed_open_source_skills':70,'supplemental_official_visible_functions':40,
 'fixed_expert_workflows':34,'new_expert_acceptance_items':68},
 'file':target.name,'bytes':target.stat().st_size,'characters':len(text),
 'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
 'balanced_fences':len(re.findall(r'^```',text,re.M))%2==0,
 'broken_local_links':relative_broken,
 'sources':[str(p.relative_to(ROOT)) for _,_,p in sections],
 'limitations':['社区内部指令未取得','补充40官方只有可见功能描述','未运行全部业务场景','未执行上游脚本','未测试真实MCP/API'],
}
(OUT/'交付核查.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
