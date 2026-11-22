# Pure-python reader for Word 97-2003 .doc (OLE CFB + piece table). Reads only; runs nothing.
import struct, sys
def cfb_streams(data):
    assert data[:8]==bytes.fromhex('d0cf11e0a1b11ae1'), 'not OLE'
    ss=1<<struct.unpack_from('<H',data,30)[0]; mss=1<<struct.unpack_from('<H',data,32)[0]
    nfat,dir1,_,cutoff,mini1,nmini,difat1,ndifat=struct.unpack_from('<IIIIIIII',data,44)
    sec=lambda i: data[512+i*ss:512+(i+1)*ss]
    difat=list(struct.unpack_from('<109I',data,76)); d=difat1
    for _ in range(ndifat):
        s=sec(d); vals=struct.unpack('<%dI'%(ss//4),s); difat+=vals[:-1]; d=vals[-1]
    fat=[]
    for f in difat[:nfat]: fat+=struct.unpack('<%dI'%(ss//4),sec(f))
    def chain(st):
        out=[]; seen=set()
        while st<0xFFFFFFFA and st not in seen: seen.add(st); out.append(st); st=fat[st]
        return out
    rd=lambda st: b''.join(sec(i) for i in chain(st))
    dirs=rd(dir1); ents=[]
    for o in range(0,len(dirs),128):
        e=dirs[o:o+128]; nl=struct.unpack_from('<H',e,64)[0]
        name=e[:max(nl-2,0)].decode('utf-16le'); typ=e[66]; start,size=struct.unpack_from('<IQ',e,116)
        ents.append((name,typ,start,size&0xFFFFFFFF))
    root=[e for e in ents if e[1]==5][0]; ministream=rd(root[2])
    minifat=[]
    if nmini: minifat=list(struct.unpack('<%dI'%(len(rd(mini1))//4),rd(mini1)))
    def mchain(st):
        out=[]
        while st<0xFFFFFFFA: out.append(st); st=minifat[st]
        return out
    res={}
    for name,typ,start,size in ents:
        if typ!=2: continue
        if size<cutoff: b=b''.join(ministream[i*mss:(i+1)*mss] for i in mchain(start))
        else: b=rd(start)
        res[name]=b[:size]
    return res
def doc_text(path):
    st=cfb_streams(open(path,'rb').read())
    wd=st['WordDocument']
    assert struct.unpack_from('<H',wd,0)[0]==0xA5EC, 'bad FIB'
    flags=struct.unpack_from('<H',wd,0x0A)[0]
    tbl=st['1Table' if flags&0x0200 else '0Table']
    csw=struct.unpack_from('<H',wd,32)[0]; p=34+csw*2
    cslw=struct.unpack_from('<H',wd,p)[0]; lw=p+2; p=lw+cslw*4
    ccpText=struct.unpack_from('<i',wd,lw+3*4)[0]
    p+=2  # cbRgFcLcb
    fcClx,lcbClx=struct.unpack_from('<II',wd,p+33*8)
    clx=tbl[fcClx:fcClx+lcbClx]; i=0
    while clx[i]==1: i+=3+struct.unpack_from('<H',clx,i+1)[0]
    assert clx[i]==2; lcb=struct.unpack_from('<I',clx,i+1)[0]; plc=clx[i+5:i+5+lcb]
    n=(lcb-4)//12; cps=struct.unpack_from('<%di'%(n+1),plc,0)
    out=[]
    for k in range(n):
        fcv=struct.unpack_from('<I',plc,(n+1)*4+k*8+2)[0]; cnt=cps[k+1]-cps[k]
        if fcv&0x40000000:
            fc=(fcv&0x3FFFFFFF)//2; out.append(wd[fc:fc+cnt].decode('cp1252',errors='replace'))
        else:
            fc=fcv&0x3FFFFFFF; out.append(wd[fc:fc+2*cnt].decode('utf-16le',errors='replace'))
    t=''.join(out)[:ccpText]
    # fields: drop instruction (0x13..0x14), keep result (0x14..0x15)
    r=[]; depth=[]
    for ch in t:
        if ch=='\x13': depth.append('i'); continue
        if ch=='\x14':
            if depth: depth[-1]='r'
            continue
        if ch=='\x15':
            if depth: depth.pop()
            continue
        if depth and 'i' in depth: continue
        r.append(ch)
    t=''.join(r).replace('\x0b','\n').replace('\x07','\n').replace('\x0c','\n').replace('\x01','').replace('\x08','')
    return t.split('\r'), list(st)
if __name__=='__main__':
    ps,names=doc_text(sys.argv[1]); print(names, len(ps))
    for i,p in enumerate(ps[:int(sys.argv[2]) if len(sys.argv)>2 else 15]): print(i,repr(p))
