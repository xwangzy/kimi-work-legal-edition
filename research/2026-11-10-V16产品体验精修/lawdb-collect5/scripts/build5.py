import json, sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ids import IDS
R=sys.argv[1]; W=sys.argv[2]; LAWS=sys.argv[3]; OUT=sys.argv[4]
P=json.load(open(f'{W}/primary_clean.json'))
GB={'leaveimpl':'https://www.gov.cn/gongbao/content/2009/content_1265995.htm','arbrule':'https://www.gov.cn/gongbao/content/2017/content_5232371.htm'}
META=[
 ('annualleave','annual_leave_reg','职工带薪年休假条例',['带薪年休假条例','年休假条例','国务院令第514号'],'行政法规','2007','2007-12-14','2008-01-01'),
 ('leaveimpl','annual_leave_impl_measures','企业职工带薪年休假实施办法',['带薪年休假实施办法','年休假实施办法','人力资源和社会保障部令第1号'],'部门规章','2008','2008-09-18','2008-09-18'),
 ('arbrule','labor_personnel_arbitration_rules','劳动人事争议仲裁办案规则',['仲裁办案规则','人力资源和社会保障部令第33号'],'部门规章','2017','2017-05-08','2017-07-01'),
 ('company_time','jud_company_time_effect','最高人民法院关于适用《中华人民共和国公司法》时间效力的若干规定',['公司法时间效力规定','公司法时间效力司法解释','法释〔2024〕7号'],'司法解释','2024','2024-06-29','2024-07-01'),
 ('regcap','company_regcap_reg','国务院关于实施《中华人民共和国公司法》注册资本登记管理制度的规定',['注册资本登记管理制度的规定','注册资本登记管理规定','国务院令第784号'],'行政法规','2024','2024-07-01','2024-07-01'),
 ('labor','law_labor','中华人民共和国劳动法',['劳动法'],'法律','2018','2018-12-29','2018-12-29'),
 ('evidence','jud_civil_evidence','最高人民法院关于民事诉讼证据的若干规定',['民事诉讼证据规定','证据规定','民事证据规定','法释〔2019〕19号'],'司法解释','2019','2019-12-25','2020-05-01'),
 ('limitation','jud_limitation','最高人民法院关于审理民事案件适用诉讼时效制度若干问题的规定',['诉讼时效规定','诉讼时效司法解释','诉讼时效制度规定'],'司法解释','2020','2020-12-29','2021-01-01'),
 ('general','jud_civil_code_general_interp','最高人民法院关于适用《中华人民共和国民法典》总则编若干问题的解释',['总则编解释','民法典总则编解释','总则编司法解释','法释〔2022〕6号'],'司法解释','2022','2022-02-24','2022-03-01'),
 ('labor2','jud_labor_dispute_interp2','最高人民法院关于审理劳动争议案件适用法律问题的解释（二）',['劳动争议解释（二）','劳动争议司法解释（二）','法释〔2025〕12号'],'司法解释','2025','2025-07-31','2025-09-01'),
 ('civil_time','jud_civil_code_time_effect','最高人民法院关于适用《中华人民共和国民法典》时间效力的若干规定',['民法典时间效力规定','民法典时间效力司法解释','法释〔2020〕15号'],'司法解释','2020','2020-12-29','2021-01-01'),
]
JUNK=re.compile(r'来源|责任编辑|打印|关闭|扫一扫|相关链接|上一篇|下一篇|版权所有|【|】|http|www\.')
doc=json.loads(open(LAWS).read())
existing={l['law_id'] for l in doc['laws']}; names={l['law_name'] for l in doc['laws']}
new=[]; problems=[]
for k,lid,name,al,level,yr,prom,eff in META:
    assert lid not in existing and name not in names, lid
    arts=[{'no':a['no'],'text':a['text']} for a in P[k]['articles']]
    nos=[a['no'] for a in arts]
    if nos!=list(range(1,len(arts)+1)): problems.append((k,'noncontig'))
    for a in arts:
        t=a['text']
        if not t.strip(): problems.append((k,a['no'],'empty'))
        if JUNK.search(t): problems.append((k,a['no'],'junk?',JUNK.search(t).group(0),t[:60]))
        if re.search(r'[ -​\xa0﻿\t]|  ',t) or t!=t.strip(): problems.append((k,a['no'],'ws'))
        if re.match(r'^第[一二三四五六七八九十百]+条',t): problems.append((k,a['no'],'prefix'))
    if k in IDS:
        d=json.load(open(f'{R}/detail_{k}.json'))['data']
        assert d['title']==name and d['sxx']==3 and d['gbrq']==prom and (d['sxrq'] in (None,eff)), (k,d['title'],d['gbrq'],d['sxrq'])
        url=f'https://flk.npc.gov.cn/detail?id={IDS[k]}'
    else: url=GB[k]
    new.append({'law_id':lid,'law_name':name,'aliases':al,'level':level,'region':'全国','versions':[{
      'lsv_id':f'lsv_{lid}_{yr}','promulgated':prom,'effective':eff,'superseded':None,'effectiveness':'valid',
      'total_articles':len(arts),'gazette_issue':'未采集','gazette_page':'未采集','collected_at':'2026-11-10',
      'official_url':url,'source_license_id':'official-text-collected-2026-11-v16','topics':{},'articles':arts}]})
    print(f'{lid}\t{len(arts)}\t{prom}\t{eff}\t{level}\t1:{arts[0]["text"][:25]}\tlast:{arts[-1]["text"][-30:]!r}')
print('problems',problems)
json.dump(new,open(OUT,'w'),ensure_ascii=False,indent=1)
print('total new articles',sum(len(x['versions'][0]['articles']) for x in new))
