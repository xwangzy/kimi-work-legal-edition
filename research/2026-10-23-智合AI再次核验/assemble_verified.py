from pathlib import Path
import collections
import hashlib
import json
import os
import re

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
OLD = ROOT / 'research/2026-10-23-智合AI全量调研'
BASE = ROOT / 'research/2026-10-21-智合AI调研'
TARGET = OUT / '00-智合AI法律业务全模块与提示词-Skills-MCP手册-重新核验版.md'
old_text = (OLD / '00-智合AI功能与法律业务提示词-Skills-MCP完整手册.md').read_text()
old_order = ['current', 'index', 'site-configuration', 'modules', 'business', 'homepage', 'workbench', 'open-skills', 'official-extra', 'experts', 'expert-qa', 'composite', 'execution', 'community-a', 'community-b', 'technical', 'competitors', 'coverage-review']


def read_json(path):
    return json.loads(path.read_text())


def rebase(path, text):
    # Only rewrite links outside fenced code, preserving quoted original methods.
    result, active, length = [], None, 0
    for line in text.splitlines(keepends=True):
        fence = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence:
            mark = fence.group(1)
            if active is None:
                active, length = mark[0], len(mark)
            elif mark[0] == active and len(mark) >= length:
                active = None
            result.append(line)
            continue
        if active:
            result.append(line)
            continue
        def fix(m):
            label, raw = m.group(1), m.group(2).strip('<>')
            if raw.startswith(('http:', 'https:', '#', 'mailto:', 'codex:', '/')):
                return m.group(0)
            dest, sep, frag = raw.partition('#')
            relative = os.path.relpath((path.parent / dest).resolve(), OUT)
            return f'[{label}](<{relative}{sep}{frag}>)'
        result.append(re.sub(r'\[([^\]]*)\]\(([^)]+)\)', fix, line))
    return ''.join(result)


def old_section(anchor):
    start = old_text.index(f'<a id="{anchor}"></a>')
    pos = old_order.index(anchor)
    end = old_text.index(f'<a id="{old_order[pos+1]}"></a>') if pos + 1 < len(old_order) else len(old_text)
    return rebase(OLD / '00-智合AI功能与法律业务提示词-Skills-MCP完整手册.md', old_text[start:end].strip())


def section(anchor, title, file):
    source = file.read_text()
    if source.startswith('# '):
        source = source.split('\n', 1)[1]
    if anchor == 'expert-market':
        source = re.sub(r'^(### (E\d{3})｜[^\n]+)$', lambda m: f'<a id="expert-market-{m.group(2)}"></a>\n\n{m.group(1)}', source, flags=re.M)
    if anchor == 'semantic-review':
        source = re.sub(r'^\| ([HS]\d{2}) \|', lambda m: f'| [{m.group(1)}](#{m.group(1)}) |', source, flags=re.M)
    return f'<a id="{anchor}"></a>\n\n# {title}\n\n' + rebase(file, source)


def normalize_category(value):
    return value.split('\n')[-1].strip()


def market_key(x):
    return x['title'], x['author'].removeprefix('by '), x['descriptionSha256'], normalize_category(x['category'])


old_market = read_json(OLD / '市场316项-方法对应.json')
new_market = read_json(OUT / '市场316条-重新逐页核对.json')['items']
new_positions = collections.defaultdict(collections.deque)
for x in new_market:
    new_positions[market_key(x)].append(x)
mapping = []
for x in old_market:
    y = new_positions[market_key(x)].popleft()
    mapping.append({**x, 'baseline_page': x['page'], 'baseline_position': x['position'], 'current_page': y['page'], 'current_position': y['position']})
assert not any(new_positions.values())
(OUT / '316条-稳定对应与本轮位置.json').write_text(json.dumps(mapping, ensure_ascii=False, indent=2) + '\n')

home = read_json(OUT / '首页36预设-重新点读.json')['items']
work = read_json(OUT / '工作台59预设-重新点读.json')['items']
assert len(home) == 36 and len(work) == 59 and all(x['unchanged'] for x in home + work)

inventory = ['<a id="index"></a>', '', '# 95 个入口与 316 条技能市场记录的完整对应', '',
    'H/S 沿用业务入口编号；M/C 沿用旧快照身份以维持方法链接，表中增加本轮位置。页码变动不代表新增或删除能力。优化均在本文件内；原始页面私有正文不在取得范围。', '',
    '## 主站 36 项', '', '| 编号 | 业务领域 | 页面任务 | 优化正文 |', '|---|---|---|---|']
for x in home:
    inventory.append(f'| {x["id"]} | {x["group"]}/{x["topic"]} | {x["title"]} | [查看](#{x["id"]}) |')
inventory += ['', '## 工作台 59 项', '', '| 编号 | 身份 | 完整卡片名称 | 优化正文 |', '|---|---|---|---|']
for x in work:
    inventory.append(f'| {x["id"]} | {x["category"]} | {x["title"]} | [查看](#{x["id"]}) |')
inventory += ['', '## 技能市场 316 行', '',
    '当前来源标签为 105 官方、5 基础、206 社区；13×24＋4 行。按名称、作者、描述摘要为 314 个可见内容组合（社区 204 组），不据此认定后台相同 ID 或私有正文完全相同。M118/M153、M121/M141 为两组同描述跨分类展示。', '',
    '| 稳定编号 | 旧页/位 | 本轮页/位 | 页面名称 | 来源 | 作者 | 优化方法 |', '|---|---|---|---|---|---|---|']
for x in mapping:
    title = x['title'].replace('|', '\\|')
    author = x['author'].removeprefix('by ') or '页面未列'
    inventory.append(f'| {x["id"]} | {x["baseline_page"]}/{x["baseline_position"]} | {x["current_page"]}/{x["current_position"]} | {title} | {x["source_label"]} | {author} | [{x["method"]}](#{x["optimization_anchor"]}) |')
inventory = '\n'.join(inventory) + '\n'

# Corrections apply to the inherited optimized text only; raw MIT sources remain intact.
corrections = {
    '先生成并确认共同底稿，再派生文件': '先建立带来源和确定程度的共同底稿，再按既定任务派生文件；已能核对的部分继续，关键冲突只暂停依赖它的结论',
    '未获真实回执的事项不得标为已完成': '各节点按完成条件取证：内部制作看产物及检查，审批/登记看相应决定或记录，发送/提交/送达分别记录证据，不要求每步均有外部回执',
    '拟提交或发送的内容保留为待签发草稿。': '拟外发内容先形成可检查的具体版本；已有明确有效授权且前置条件满足时继续相应动作，缺授权、版本/收件人不明或超范围时才保留待签发，并记录未做部分。',
    '以本任务实际纳入的路径和适用条件列清单，确认后再比较，不照抄数量或强行凑数。': '按本任务目标和适用条件列实际路径后直接比较；标题数量不作为限制，不强行凑数。关键事实不足时列条件分支，仅就影响推荐的缺口询问。',
    '主控确认后生成“已确认事实包”；独立专家只读取该包，并将缺项结构化返回，不在所有专家里重复询问。': '主控建立版本化事项包，保留材料记载、当事人陈述、已认定事实、争议、推论、反证和缺口；各专家读取同版并带出处返回增量，不重复询问已知信息，也不提升事实确定程度。',
    '先展示原文与改写差异，再由用户接受或继续编辑；': '保留原文与改写差异并提供可编辑稿；已授权的后续工作在目标、事实和权限未改变时继续；改变关键目标或新增外部动作才补充澄清；',
    '保存确认后的参数版本供后续步骤复用。': '保存参数版本、来源、核对方式与确定程度供后续复用；用户确认仅证明其表达或选择，材料支持与法律判断分别记录，冲突保留待核。',
    '没有真实回执不得说已发送': '没有可核实的发送证据不称已发送；工具或服务受理可记相应状态，送达、接收与已读另据证据记录',
    '投稿发布须另行授权': '发布核对已有明确授权，范围充分时执行；仅准备内容不扩张到发布，范围不足或有实质变化才补充确认',
    '任何发布、留言或私信须单独授权': '发布、留言或私信核对既有授权的对象、渠道、内容与范围；充分时执行，超范围时询问，不从运营规划推定联系任何人的权限',
    '顺序确认后合并提交副本、连续编页，': '按已给顺序或合理分组制作可撤销的合并副本并连续编页，保留原件；顺序有影响证明目的的关键歧义时只澄清该项，',
    '用户确认后才起草适用文书。': '按明确任务直接起草适用文书；影响文种、请求或立场的关键歧义先澄清，其余用占位和分支继续，提交另按实际授权处理。',
    '低清页先请求补图，其他页可继续；后续结论只使用已确认字段。': '低清页列具体补图要求，其他页继续；关键疑点只阻断依赖它的命题，清楚字段可按来源和采用前提用于其他结论，不把人工采用等同法院认定。',
    '形成可复核成品后由授权人员决定': '先形成具体可复核版本，核对实际授权、对象及前置条件；充分时继续执行，超范围或关键条件缺失才补充确认',
}
patch_counts = collections.Counter()


def append_prompt(text, entry, addition):
    start = text.index(f'<a id="{entry}"></a>')
    opening = text.index('```text\n', start)
    end = text.index('\n```', opening + 8)
    return text[:end] + '\n' + addition + text[end:]


def inherited(anchor):
    text = old_section(anchor)
    text = text.replace('本章优化正文承接 2026-10-21/22 的工作区原创基线；本日重新点读与目录对应在前文。章节中的历史观察、来源日期和固定源码范围保留，法律规则需按具体事项时点核验；新增迁移纠偏以当日裁决和技术章为准。',
        '本章承接工作区既有原创优化；本轮对95个预设和316条市场展示记录重新点读，并实施必要的状态与确认措辞修订。原研究日期保留，法律规则按具体事项时点核验；这些文字不是已运行的Skill包。')
    if anchor in ('community-a', 'community-b'):
        text = text.replace('页面记录：', '旧快照页面记录：').replace('；位置：第', '；旧快照位置：第')
        first_heading = text.find('\n\n', text.find('# '))
        text = text[:first_heading] + '\n\n**位置说明：本章的C编号和分页记载沿用旧快照；本轮位置见完整对应目录。名称/作者/描述摘要集合已经重新逐页核对，推荐排序16条换位。这里的原创方法不表示取得社区私有正文。**' + text[first_heading:]
        if anchor == 'community-b':
            text = text.replace('C204—C206是今日观察相对昨日目录新增的三条位置', 'C204—C206是同日早一批次观察相对10月22日目录新增的三条位置')
            text = text.replace('C203“义乌厂房买卖税费测算”为第14页昨日已有条目', 'C203“义乌厂房买卖税费测算”为第14页10月22日已记条目')
            text = text.replace('今日新增三条', '同日早一批次观察新增三条')
            text = text.replace('今日新增', '同日早一批次观察新增')
            text = text.replace('新增目录位置：今日', '旧快照观察位置：该批次')
    for old, new in corrections.items():
        found = text.count(old)
        if found:
            patch_counts[old] += found
            text = text.replace(old, new)
    if anchor == 'open-skills':
        text = re.sub(r'(<a id="skill-(\d{2})"></a>\n\n### [^\n]+\n)', lambda m: m.group(1) + f'\n[本文件内的MIT原始正文](#raw-skill-{m.group(2)})；当前段为原创优化，二者分开阅读。\n', text)
    if anchor == 'experts':
        text = re.sub(r'(<a id="expert-(WF\d{2})"></a>\n\n### [^\n]+\n)', lambda m: m.group(1) + f'\n[本文件内的MIT原始配置](#raw-expert-{m.group(2)})；公开广场同名条目仍需按作者和来源区分。\n', text)
        start = text.index('<a id="expert-WF01"></a>')
        end = text.index('<a id="expert-WF02"></a>', start)
        chunk = text[start:end]
        chunk = re.sub(r'(?m)^(> .+)$', lambda m: m.group(1) + '\n> 具体分直接起诉、复议后、履职不答复及登记纠错；分别登记行为作出、知悉内容与实施主体、送达、告知、申请接收和特殊耽误证据，不将六个月、最长一年、二十年/五年或十五日合为统一期限，也不从新解释施行日自动重算旧案。', chunk, count=1)
        text = text[:start] + chunk + text[end:]
    if anchor == 'homepage':
        text = append_prompt(text, 'H25', '另核特殊待遇对应服务期限的事实与2025年司法解释责任条件，不把缺少培训直接推成不存在任何服务期限问题，也不据此约定任意高额违约金。任职义务、劳动约定与真实交易承诺分别评估。')
    if anchor == 'workbench':
        text = append_prompt(text, 'S39', '如实回答不等于接受指控或必须认罪；按具体主体和程序同时说明无罪辩解、不得强迫自证其罪、无关问题拒答和笔录核对改正。对线索记录原话及合法核查任务，不预编口供。')
        text = append_prompt(text, 'S56', '针对民事当事人申请再审，先核现行一般六个月及特殊事由起算；申请执行二年另核履行期、生效及中止中断，不套用同一起点，也不因申请再审推定执行停止。其他主体、文书或特殊程序单独查规则。')
        text = append_prompt(text, 'S54', '遗产税domicile不与中国户籍或惯常居所直接等同；按被继承人死亡时事实与年份核验，继承人身份可能影响其自身申报但不能替代此判断。联邦税、州税、遗嘱效力和遗产承办程序分别交当地核查。')
    if anchor == 'technical':
        text = text.replace('本次浏览工具打开该仓库及固定提交页面未成功，故不声明已联网重新取得或确认上游最新状态。', '同日早一批次技术子研究未成功打开仓库；本轮协议子研究已通过官方GitHub API补证main仍指向该固定提交，并逐个比对70+34份方法正文。此处的初始访问失败不再构成当前未核验事项。')
        text = text.replace('旧包中的 36 首页场景与 59 工作台场景应当作为旧记录，待主代理今日现场逐项核验。', '既有研究的36个首页与59个工作台预设已在本轮由主代理逐卡重新读取，95/95文本摘要一致；它们与公开源码仍是不同对象。')
        start = text.index('推荐状态机：')
        end = text.index('## 11. 评测、发布与优先级', start)
        text = text[:start] + '''推荐把运行、产物和外部动作分为三条状态轴：

~~~text
运行：planned → running → succeeded / partial / failed / cancelled
      只有确缺当前必要输入的步骤进入 waiting_for_input；独立步骤继续。
产物：working_draft → checks_passed / checks_with_issues
      → review_required（适用时）→ approved（实际审定时）
动作：not_requested / authorized / executing / accepted / rejected / delivery_unknown
      签署、提交、送达、接收、已读、履约各有独立业务事件和证据。
~~~

运行完成不自动表示专业审定或实际履行。内部整理、研究和草稿完成约定产物及必要检查即可交付；核心缺口仍阻断交付时标部分完成或待输入，不能仅因缺口已标记就把整项标成功。保留输入、方法、工具版本、处理覆盖和错误；对受影响对象重算或重写，不覆盖人类修订或已签发件。已有有效授权沿用，关键对象、版本、权限或选择缺失时才询问；外部动作重试需幂等，取消后按真实停止状态记录。

''' + text[end:]
        start = text.index('## 12. 仍需主代理现场确认的智合边界')
        text = text[:start] + '''## 12. 本轮已补证与仍未运行的智合边界

- 已重新点读：主站36、工作台59预设；技能市场316行；专家广场79行；手册v1.6全部17章。
- 已查看配置：模型、技能与执行面板；Skill/专家空创建器；MCP公开、Bearer、OAuth空表单及双向说明。
- 仍属页面或厂商说明：真实模型路由、自动选方法效果、实际工具/数据范围、隔离、加密、计费、自动更新与后台恢复。
- 未运行：业务场景、真实MCP/API、客户材料上传、付费检索、多文件成品、团队共享、定时和群推送。
- 未取得：隐藏系统提示、私有Skill正文、生产路由与后台实现。本文所有建议Schema和工具名均为原创设计。

配置可读、方法文件存在与真实业务验收是不同完成度，不相互代替。
'''
    if anchor == 'competitors':
        text = text.replace('对外动作单独授权', '对外动作遵守当前及既有有效授权；范围充分时继续，超范围或关键对象/版本不明才补充确认')
        start = text.index('## 7. 尚待主任务现场确认')
        text = text[:start] + '''## 7. 本轮补证与运行边界

- 可见入口、分类和预设已重新覆盖：36首页、59工作台、316技能行与79专家行；95预设摘要与旧记录一致。
- 手册已更新到v1.6，MCP配置空表单已读取；70源技能与34源专家正文已与当日上游核对。
- 场景卡插入的可见用户指令不等于后台系统指令，社区/专家私有正文及生产路由仍未取得；源码与线上配置逐字一致也未证实。
- 上传和OCR、真实修订导出、工具日志、计费、任务恢复、MCP调用、知识库隔离、团队及定时任务仍需实际运行验收。本轮没有客户材料上传或真实外发。

按“已观察/官方说明/历史记录/原创设计/待运行”使用这些成果，不因目录完整就提升证据级别。
'''
    return text


main_sections = [
    ('verified', '本轮重新调研、证据与历史裁决', OUT / '01-本轮复核与裁决.md'),
    ('semantic-review', '95 个预设的语义与逐项优化复核', OUT / '03-95预设语义与优化复核.md'),
    ('index', '95 个入口与 316 条技能记录的完整对应', None),
    ('site-configuration', '当前17章功能与配置：v1.6、Skills、专家和MCP', OUT / '02-当前功能模块与配置.md'),
    ('business-upgrade', '六条业务主线、模块交接与五个完整工作流', OUT / '子研究-业务与提示词质量.md'),
    ('modules', '业务对象、材料、共享底稿与质量方法', None),
    ('business', '81 个法律业务任务模块与依赖', None),
    ('homepage', '首页36场景完整优化提示词', None),
    ('workbench', '工作台59场景完整优化提示词', None),
    ('open-skills', '70项开源Skill逐项优化与验收', None),
    ('official-extra', '40项额外官方展示功能原创重构', None),
    ('experts', '34个公开源码专家工作流与优化指令', None),
    ('expert-qa', '34个源码专家的专属验收设计', None),
    ('expert-market', '79条公开专家逐项方法与优化指令', OUT / '专家广场79项-逐项方法与优化指令.md'),
    ('composite', '组合交付、图片与公共工序', None),
    ('execution', '五项跨场景执行控制', None),
    ('community-a', '社区C001—C103逐项原创方法', None),
    ('community-b', '社区C104—C206逐项原创方法', None),
    ('technical', 'Skills、MCP与建议工具契约和评测', None),
    ('protocol-verification', '本轮联网核验：协议、开源包与国际产品方法', OUT / '子研究-协议与竞品证据.md'),
    ('legal-premises', '五项关键法律前提的官方来源核验与专门指令', OUT / '子研究-关键法律前提核验.md'),
    ('competitors', '法律业务与官方竞品资料研究基线', None),
    ('coverage-review', '既有逐项覆盖与法律前提复核', None),
    ('history-audit', '独立历史审计、补证和具体措辞修正', OUT / '子研究-历史审计.md'),
    ('raw-public', '附录：70项MIT开源Skill完整原始正文', BASE / '70项技能原文合辑.md'),
    ('raw-experts', '附录：34个MIT专家原始配置', None),
]

missing = [str(p.name) for _, _, p in main_sections if p is not None and not p.exists()]
if missing:
    print(json.dumps({'waiting_for': missing}, ensure_ascii=False))
    raise SystemExit(2)

parts = ['''# 智合 AI 法律业务全模块、提示词、Skills 与 MCP 手册（重新核验修订版）

研究日期：2026-10-23，Asia/Shanghai。**主代理通过 computer use 重新点读全部95个预设、316条技能市场记录，并新增覆盖79条公开专家；三个subagent分别联网核验官方证据、独立审计和优化业务方法。** 历史报告保留，本文件整合完整逐项库及本轮修订，无须自行拼接补丁。

旧研究总体方向恰当；本轮更新手册v1.6、MCP表单、专家广场覆盖、重复与排序口径，并修正不必要的确认门槛和状态混淆。统计对象存在重叠，不能相加为独立能力。

正文明确区分：可见预设/公开说明、MIT源码原文、工作区原创优化、建议工具契约与真实运行证据。**没有取得社区私有指令或隐藏系统提示词，也没有把配置可见、静态审查或提示词存在称作运行验收。** 原始MIT正文另列附录且保留许可；其中已知问题未被静默改写，优化方法在主体章节。

按“事项→阶段/目标→材料与事实→专业方法→工具→核验→可编辑成果→后续动作”阅读。业务、方法、配置和质量分别有层级；图片是输入形态，OCR是工具，证据整理才是专业任务。

## 阅读导航

先看本轮裁决和当前功能；按H/S查场景，按K/skill查开源方法，按O/official查额外官方展示功能，按C查社区方法，按WF查源码专家，按E查公开专家。输入、方法步骤、输出、失败与验收应一起阅读，短任务只加载相关要求。

''', '\n'.join(f'- [{title}](#{anchor})' for anchor, title, _ in main_sections), '\n']

for anchor, title, file in main_sections:
    if anchor == 'index':
        text = inventory
    elif anchor == 'raw-public':
        raw = file.read_text().split('\n', 1)[1]
        raw = re.sub(r'^(## (\d{2})\. [^\n]+ · [a-z][a-z0-9-]+)$', lambda m: f'<a id="raw-skill-{m.group(2)}"></a>\n\n{m.group(1)}', raw, flags=re.M)
        text = f'<a id="{anchor}"></a>\n\n# {title}\n\n以下按固定提交原样存档，未执行。原文中的脚本命令、法律概括和工具声明均是研究对象，不是本项目运行指令；已知缺陷见前文审计。附录保留完整MIT许可，配套文件仍见固定仓库。\n\n' + raw
    elif anchor == 'raw-experts':
        wf_source = (BASE / '06-官方34专家工作流逐项优化.md').read_text()
        items = re.findall(r'^### (WF\d{2}) ([^\n]+)\n\n- \*\*源码定位：\*\* `([^`]+)`', wf_source, re.M)
        assert len(items) == 34
        raw_parts = [f'<a id="{anchor}"></a>\n\n# {title}\n\n固定提交与前附MIT许可相同。下列为未经改写的原始配置，不是已适配运行包；其确认/默认值和宿主约束等问题见优化章节。\n']
        for wf, name, dirname in items:
            path = BASE / '上游来源/legal-agent-skills/experts' / dirname / 'EXPERT.md'
            raw = path.read_text()
            raw_parts += [f'\n<a id="raw-expert-{wf}"></a>\n\n## {wf} {name}\n\n[优化工作流](#expert-{wf})\n\n来源：`experts/{dirname}/EXPERT.md`；SHA-256：`{hashlib.sha256(path.read_bytes()).hexdigest()}`\n\n````markdown\n{raw}\n````\n']
        text = '\n'.join(raw_parts)
    elif file is not None:
        text = section(anchor, title, file)
    else:
        text = inherited(anchor)
    parts += ['\n\n', text]

TARGET.write_text('\n'.join(parts))
(OUT / '措辞修订记录.json').write_text(json.dumps(dict(patch_counts), ensure_ascii=False, indent=2) + '\n')

# Validate rendered Markdown links and fences, ignoring verbatim fenced source blocks.
text = TARGET.read_text()
visible_lines, active, length = [], None, 0
fence_errors = []
for lineno, line in enumerate(text.splitlines(), 1):
    fence = re.match(r'^\s*(`{3,}|~{3,})', line)
    if fence:
        mark = fence.group(1)
        if active is None:
            active, length = mark[0], len(mark)
        elif mark[0] == active and len(mark) >= length:
            active = None
        continue
    if active is None:
        visible_lines.append((lineno, line))
if active:
    fence_errors.append('unclosed fenced block')
visible = '\n'.join(line for _, line in visible_lines)
anchors = re.findall(r'<a id="([^\"]+)">', visible)
known = set(anchors)
broken = []
for lineno, line in visible_lines:
    for label, raw in re.findall(r'\[([^\]]*)\]\(([^)]+)\)', line):
        raw = raw.strip('<>')
        if raw.startswith('#'):
            if raw[1:] not in known:
                broken.append({'line': lineno, 'target': raw})
        elif not raw.startswith(('http:', 'https:', 'mailto:', 'codex:')):
            dest = raw.split('#')[0]
            if dest and not (OUT / dest).exists():
                broken.append({'line': lineno, 'target': raw})

expert_mapping = read_json(OUT / '专家广场79项-方法映射.json')
expert_items = expert_mapping if isinstance(expert_mapping, list) else expert_mapping['items']
expert_ids = [x['id'] for x in expert_items]
counts = {
    'homepage': sum(bool(re.fullmatch(r'H\d{2}', x)) for x in anchors),
    'workbench': sum(bool(re.fullmatch(r'S\d{2}', x)) for x in anchors),
    'open_skills': sum(bool(re.fullmatch(r'skill-\d{2}', x)) for x in anchors),
    'official_extra': sum(bool(re.fullmatch(r'official-\d{2}', x)) for x in anchors),
    'source_experts': sum(bool(re.fullmatch(r'expert-WF\d{2}', x)) for x in anchors),
    'expert_market': sum(bool(re.fullmatch(r'expert-market-E\d{3}', x)) for x in anchors),
    'community_methods': sum(bool(re.fullmatch(r'community-C\d{3}', x)) for x in anchors),
    'raw_skills': sum(bool(re.fullmatch(r'raw-skill-\d{2}', x)) for x in anchors),
    'raw_experts': sum(bool(re.fullmatch(r'raw-expert-WF\d{2}', x)) for x in anchors),
}
duplicates = [key for key, count in collections.Counter(anchors).items() if count > 1]
evidence = [{'path': str(p.relative_to(OUT)), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted((OUT / 'evidence').glob('*.png'))]
raw_parity_errors = []
skill_catalog = read_json(BASE / '70项技能核验清单.json')['items']
for x in skill_catalog:
    match = re.search(r'<a id="raw-skill-%02d"></a>.*?````markdown\n(.*?)\n````' % x['number'], text, re.S)
    paths = list((BASE / '上游来源/legal-agent-skills/skills').glob('*/' + x['id'] + '/SKILL.md'))
    if len(paths) != 1 or not match or match.group(1).rstrip('\n') != paths[0].read_text().rstrip('\n'):
        raw_parity_errors.append(x['id'])
wf_source = (BASE / '06-官方34专家工作流逐项优化.md').read_text()
for wf, name, dirname in re.findall(r'^### (WF\d{2}) ([^\n]+)\n\n- \*\*源码定位：\*\* `([^`]+)`', wf_source, re.M):
    match = re.search(r'<a id="raw-expert-' + wf + r'"></a>.*?````markdown\n(.*?)\n````', text, re.S)
    source = (BASE / '上游来源/legal-agent-skills/experts' / dirname / 'EXPERT.md').read_text()
    if not match or match.group(1).rstrip('\n') != source.rstrip('\n'):
        raw_parity_errors.append(wf)
report = {
    'date': '2026-10-23', 'timezone': 'Asia/Shanghai', 'file': TARGET.name,
    'characters': len(text), 'bytes': TARGET.stat().st_size, 'lines': len(text.splitlines()),
    'sha256': hashlib.sha256(TARGET.read_bytes()).hexdigest(), 'counts': counts,
    'preset_hash_matches': 95, 'market_rows': len(new_market),
    'market_content_combinations': len(set((x['title'], x['author'].removeprefix('by '), x['descriptionSha256']) for x in new_market)),
    'market_multiset_equal': collections.Counter(market_key(x) for x in old_market) == collections.Counter(market_key(x) for x in new_market),
    'market_position_changes': sum((x['baseline_page'], x['baseline_position']) != (x['current_page'], x['current_position']) for x in mapping),
    'expert_market_rows': len(expert_items), 'expert_ids_contiguous': expert_ids == [f'E{i:03}' for i in range(1, 80)],
    'duplicate_anchors': duplicates, 'broken_local_links': broken, 'fence_errors': fence_errors,
    'raw_method_bodies_equal': 104 - len(raw_parity_errors), 'raw_method_body_errors': raw_parity_errors,
    'wording_correction_locations': sum(patch_counts.values()), 'evidence': evidence,
    'limits': ['社区私有正文未取得', '场景业务未逐项运行', '真实MCP和数据库未连接', '未交付适配后的可安装技能包', '原始源码附录未改写或执行'],
}
(OUT / '交付核查.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
assert not broken and not duplicates and not fence_errors
assert not raw_parity_errors
assert counts == {'homepage': 36, 'workbench': 59, 'open_skills': 70, 'official_extra': 40, 'source_experts': 34, 'expert_market': 79, 'community_methods': 206, 'raw_skills': 70, 'raw_experts': 34}
assert report['market_multiset_equal'] and report['expert_ids_contiguous']
