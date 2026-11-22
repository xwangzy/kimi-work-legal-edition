import json, sys, os, re
R=sys.argv[1]; W=sys.argv[2]; OUT=sys.argv[3]
META=[
 ('patent','patent_law','中华人民共和国专利法',['专利法'],'法律','2020',None),
 ('antimonopoly','antimonopoly_law','中华人民共和国反垄断法',['反垄断法'],'法律','2022',None),
 ('laborreg','labor_contract_reg','中华人民共和国劳动合同法实施条例',['劳动合同法实施条例','国务院令第535号'],'行政法规','2008','2008-09-18'),
 ('unfair','anti_unfair_competition_law','中华人民共和国反不正当竞争法',['反不正当竞争法'],'法律','2025',None),
 ('datasec','data_security_law','中华人民共和国数据安全法',['数据安全法'],'法律','2021',None),
]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from ids import IDS
flk=json.load(open(f'{W}/flk_split.json'))
laws=[]
for k,lid,name,al,level,yr,eff_override in META:
    d=json.load(open(f'{R}/detail_{k}.json'))['data']
    assert d['title']==name and d['sxx']==3 and d['bbbs']==IDS[k], (k,d['title'],d['sxx'])
    arts=[{'no':a['no'],'text':a['text']} for a in flk[k]['articles']]
    nos=[a['no'] for a in arts]; assert nos==list(range(1,len(arts)+1)) and all(a['text'] for a in arts)
    eff=d['sxrq'] or eff_override
    laws.append({'law_id':lid,'law_name':name,'aliases':al,'level':level,'region':'全国','versions':[{
      'lsv_id':f'lsv_{lid}_{yr}','promulgated':d['gbrq'],'effective':eff,'superseded':None,'effectiveness':'valid',
      'total_articles':len(arts),'gazette_issue':'未采集','gazette_page':'未采集','collected_at':'2026-11-07',
      'official_url':f'https://flk.npc.gov.cn/detail?id={IDS[k]}','source_license_id':'official-text-collected-2026-11',
      'topics':{},'articles':arts}]})
    inner=[a['no'] for a in arts if re.search(r'[　​\xa0\t]| {2,}',a['text'])]
    print(lid,len(arts),d['gbrq'],eff,'inner-space arts',inner[:10],'| 1:',arts[0]['text'][:40],'| last:',arts[-1]['text'])
json.dump(laws,open(OUT,'w'),ensure_ascii=False,indent=1)
print('wrote',OUT,len(laws))
