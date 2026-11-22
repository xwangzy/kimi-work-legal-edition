import json,sys
LAWS,REG,NEW=sys.argv[1:4]
doc=json.loads(open(LAWS).read()); new=json.load(open(NEW))
doc['_comment']+=" V16 第 41 批（2026-11-10 采集，来源登记 official-text-collected-2026-11-v16）：再收 11 部 447 条全文——职工带薪年休假条例、国务院关于实施公司法注册资本登记管理制度的规定（行政法规）；企业职工带薪年休假实施办法、劳动人事争议仲裁办案规则（部门规章，国家法律法规数据库不收规章，以中国政府网刊载的国务院公报文本为主来源，与国家规章库 / 司法部 / 地方人社网站逐条比对；仲裁办案规则公报文本用阿拉伯数字、规章库等写汉字数字，按公报标准文本入库）；劳动法（2018 年修正）；公司法时间效力规定、民事诉讼证据规定（2019 年修正）、诉讼时效规定（2020 年修正）、民法典总则编解释、劳动争议解释（二）、民法典时间效力规定（司法解释，flk 官方 Word 文本与法院网 / 最高法公报网 / 国际商事法庭网逐条比对；司法解释里“一、一般规定”这类分部标题不进条文）。公司法第八十八条第一款不溯及适用的批复（法释〔2024〕15号）没有条号，现有按条号存储与核验的结构无法如实表示，未入库。"
doc['laws']+=new
open(LAWS,'w').write(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
reg=json.loads(open(REG).read())
assert all(r['source_license_id']!='official-text-collected-2026-11-v16' for r in reg)
reg.append({
 "source_license_id":"official-text-collected-2026-11-v16","source_type":"official_gazette",
 "licensor":"无（立法文件、司法解释不适用著作权法）",
 "acquired_via":"官方发布文本采集（V16 第 41 批）：法律、行政法规、司法解释取国家法律法规数据库（flk.npc.gov.cn）官方 Word 文本逐条切分；部门规章取中国政府网（www.gov.cn）刊载的国务院公报文本；均与第二官方来源逐条比对",
 "contract_ref":None,"valid_until":None,
 "allowed_actions":["search","display","quote","cache","vectorize","model","export","train","retain_after_termination"],
 "region":"全国","firm_limit":None,"concurrency_limit":None,
 "citation_requirement":"官方发布文本（著作权法第五条）。2026-11-10 采集 11 部 447 条全文，每部与至少一个第二官方来源逐条比对：劳动法对中国人大网；两部行政法规对中国政府网 / 国务院公报或生态环境部、农业农村部转载页；两部部门规章以国务院公报为主来源，对国家规章库、司法部、上海 / 广东人社网站；六部司法解释对最高人民法院官网、最高法公报网、国际商事法庭网或知识产权法庭网。差异如实保留：年休假条例第二、四条与公司法时间效力规定第二条、总则编解释第三十一条官方 Word 为半角标点，网页为全角，文字相同；年休假实施办法第十条国家规章库多一“年”字、少一“的”字，按公报（司法部页面相同）；仲裁办案规则 24 条公报用阿拉伯数字、规章库与地方网站用汉字数字，按公报标准文本。法释〔2024〕15号批复无条号，未入库。公报期号未采集。",
 "deletion_obligation":None,"acquired_at":"2026-11-10","reliability":"official_text_collected","withdrawn_reason":None})
s=json.dumps(reg,ensure_ascii=False,indent=2)+'\n'
open(REG+'.new','w').write(s)
print(len(doc['laws']),sum(len(v['articles']) for l in doc['laws'] for v in l['versions']),sum(len(l['versions']) for l in doc['laws']))
e=reg[-1]; old=open(REG).read().rstrip()
assert old.endswith('}\n]')
lines=[]
for k,v in e.items():
    if isinstance(v,list): lines.append(f'    "{k}": ['+', '.join(json.dumps(x,ensure_ascii=False) for x in v)+']')
    else: lines.append(f'    "{k}": '+json.dumps(v,ensure_ascii=False))
block='  {\n'+',\n'.join(lines)+'\n  }'
out=old[:-2]+'},\n'+block+'\n]\n'
json.loads(out)
open(REG,'w').write(out)
import os; os.remove(REG+'.new')
print('registry ok',len(json.loads(out)))
