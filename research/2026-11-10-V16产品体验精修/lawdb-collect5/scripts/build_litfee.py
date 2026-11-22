"""《诉讼费用交纳办法》入库：flk Word 切条 → 校验 → 追加到 laws.json，并在 v16 来源登记的说明末尾补一句。
用法：python3 -I scripts/build_litfee.py <lawdb-collect5 目录> <platform/content/lawdb/sources 目录>
"""
import json, re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from docx2txt import paras
from split import split_lines, check
D, S = sys.argv[1], sys.argv[2]
LAWS, REG = f'{S}/laws.json', f'{S}/source_registry.json'
BBBS = 'ff8080816f3e98bd016f41e1395a015f'
ps, _ = paras(f'{D}/raw/docx/litfee.docx')
arts, heads, pre = split_lines(ps)
ok, nos = check(arts)
assert ok and len(arts) == 56, (ok, len(arts))
for a in arts:
    t = a['text']
    assert t.strip() and t == t.strip() and not re.search(r'第[一二三四五六七八九十]+章', t), a['no']
    assert not re.search(r'[\t\xa0　]|  ', t), a['no']
d = json.load(open(f'{D}/raw/detail_litfee.json'))['data']
assert d['title'] == '诉讼费用交纳办法' and d['sxx'] == 3 and d['gbrq'] == '2006-12-19' and d['flxz'] == '行政法规', d
assert arts[55]['text'] == '本办法自2007年4月1日起施行。'
TOPICS = {
    '诉讼费用的范围': 6, '不交纳案件受理费的案件': 8, '申请费的事项': 10,
    '财产案件受理费分段累计标准': 13, '非财产案件受理费': 13, '劳动争议案件受理费': 13,
    '申请费标准': 14, '保全申请费': 14, '支付令申请费': 14,
    '调解或撤诉减半交纳': 15, '简易程序减半交纳': 16, '上诉案件受理费计算': 17, '反诉减半交纳': 18,
    '受理费预交主体': 20, '变更诉讼请求数额': 21, '受理费交纳期限': 22, '上诉案件受理费预交': 22,
    '发回重审退还二审受理费': 27, '诉讼费用负担原则': 29, '调解结案费用负担': 31, '撤诉费用负担': 34,
    '执行与保全申请费负担': 38, '诉讼费用决定的复核': 43,
    '司法救助': 44, '免交情形': 45, '减交情形': 46, '缓交情形': 47, '外币换算': 55,
}
for k, n in TOPICS.items():
    assert 1 <= n <= 56
doc = json.loads(open(LAWS).read())
assert all(l['law_id'] != 'litigation_fee_measures' and l['law_name'] != '诉讼费用交纳办法' for l in doc['laws'])
doc['_comment'] += (" 同批补收《诉讼费用交纳办法》（国务院令第481号，2006-12-19 公布、2007-04-01 施行，56 条；flk 时效性有效、"
    "同名仅此一版、未修订）：flk 官方 Word 文本切条，与中国政府网法规页、国务院公报 2007 年第 4 号、最高人民法院知识产权法庭网逐条比对，"
    "除第十三、十四条项下序号“1．”官方 Word 为全角点、网页为半角点及全角半角括号外文字一致，按 flk 文本入库；"
    "文中所引民事诉讼法条号（第十一条第三款、第五十五条第四款、第三十六至三十九条、第一百三十七条）为 1991 年民事诉讼法序号，须对照现行民事诉讼法。")
doc['laws'].append({
    'law_id': 'litigation_fee_measures', 'law_name': '诉讼费用交纳办法',
    'aliases': ['国务院令第481号'], 'level': '行政法规', 'region': '全国',
    'versions': [{
        'lsv_id': 'lsv_litigation_fee_measures_2006', 'promulgated': '2006-12-19', 'effective': '2007-04-01',
        'superseded': None, 'effectiveness': 'valid', 'total_articles': 56,
        'gazette_issue': '未采集', 'gazette_page': '未采集', 'collected_at': '2026-11-10',
        'official_url': f'https://flk.npc.gov.cn/detail?id={BBBS}',
        'source_license_id': 'official-text-collected-2026-11-v16', 'topics': TOPICS,
        'articles': [{'no': a['no'], 'text': a['text']} for a in arts]}]})
open(LAWS, 'w').write(json.dumps(doc, ensure_ascii=False, indent=2) + '\n')
reg = open(REG).read()
old = '法释〔2024〕15号批复无条号，未入库。公报期号未采集。"'
assert reg.count(old) == 1
new = ('法释〔2024〕15号批复无条号，未入库。同批补收《诉讼费用交纳办法》（国务院令第481号）56 条，flk Word 与中国政府网法规页、'
       '国务院公报 2007 年第 4 号、最高人民法院知识产权法庭网逐条比对，仅第十三、十四条项下序号点号与括号全角半角不同，按 flk。公报期号未采集。"')
reg = reg.replace(old, new); json.loads(reg)
open(REG, 'w').write(reg)
print('laws', len(doc['laws']), 'articles', sum(len(v['articles']) for l in doc['laws'] for v in l['versions']))
