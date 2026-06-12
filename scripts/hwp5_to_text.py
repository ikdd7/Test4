#!/usr/bin/env python3
# 바이너리 HWP 5.0(.hwp, OLE) → 텍스트 추출기 (별표/서식 등 한글 전용 바이너리용)
# 사용: pip3 install olefile;  python3 scripts/hwp5_to_text.py 파일.hwp
# 국가법령정보센터 HWPML(XML .hwp)은 ingest가 직접 읽으므로 이 스크립트가 필요 없습니다.
import sys, struct, zlib, olefile
EXT8={1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23}
def para_text(p):
    out=[]; i=0; n=len(p)
    while i+1<n:
        c=struct.unpack_from('<H',p,i)[0]
        if c>=32: out.append(chr(c)); i+=2
        elif c in (10,13): out.append('\n'); i+=2
        elif c==9: out.append('\t'); i+=2
        elif c in EXT8: i+=16
        else: i+=2
    return ''.join(out)
def section_text(data):
    pos=0; out=[]
    while pos+4<=len(data):
        h=struct.unpack_from('<I',data,pos)[0]; pos+=4
        tag=h&0x3FF; size=(h>>20)&0xFFF
        if size==0xFFF: size=struct.unpack_from('<I',data,pos)[0]; pos+=4
        payload=data[pos:pos+size]; pos+=size
        if tag==67:
            t=para_text(payload).strip()
            if t: out.append(t)
    return '\n'.join(out)
def extract(path):
    ole=olefile.OleFileIO(path)
    secs=sorted([e for e in ole.listdir() if len(e)==2 and e[0]=='BodyText' and e[1].startswith('Section')], key=lambda e:e[1])
    txt=[]
    for e in secs:
        raw=ole.openstream(e).read()
        try: data=zlib.decompress(raw,-15)
        except Exception: data=raw
        txt.append(section_text(data))
    ole.close(); return '\n'.join(txt)
if __name__=='__main__':
    print(extract(sys.argv[1]))
