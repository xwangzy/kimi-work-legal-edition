import zipfile, sys, re, os
import xml.etree.ElementTree as ET
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def paras(path):
    z=zipfile.ZipFile(path)
    names=z.namelist()
    x=z.read('word/document.xml')
    root=ET.fromstring(x)
    out=[]
    for p in root.iter(W+'p'):
        s=[]
        for el in p.iter():
            if el.tag==W+'t': s.append(el.text or '')
            elif el.tag==W+'tab': s.append('\t')
            elif el.tag in (W+'br',W+'cr'): s.append('\n')
        out.append(''.join(s))
    return out, names
if __name__=='__main__':
    src=sys.argv[1]; dst=sys.argv[2]
    os.makedirs(dst,exist_ok=True)
    for f in sorted(os.listdir(src)):
        if not f.endswith('.docx'): continue
        ps,names=paras(os.path.join(src,f))
        k=f[:-5]
        open(os.path.join(dst,k+'.txt'),'w').write('\n'.join(f'{i}\t{repr(p)}' for i,p in enumerate(ps)))
        print(k,len(ps),'paras; nonempty',sum(1 for p in ps if p.strip()),'; parts',[n for n in names if n.startswith('word/') and n.endswith('.xml')][:8])
