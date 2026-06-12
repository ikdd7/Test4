#!/usr/bin/env python3
# 소방청 「소방시설법령 질의회신집」 PDF → 질의회신 텍스트(=== 구분) 변환기
# 사용: pip3 install pymupdf;  python3 scripts/pdf_qa_to_text.py 입력.pdf 출력.txt
import sys, re
import fitz

def clean_pages(doc, booklet):
    lines=[]
    for p in range(doc.page_count):
        for ln in doc[p].get_text().split('\n'):
            s=ln.strip()
            if not s: continue
            if s==booklet: continue                  # 책자 제목 머리글
            if re.fullmatch(r'\d{1,3}', s): continue # 페이지 번호
            if re.fullmatch(r'[ⅠⅡⅢⅣⅤⅥⅦ]\.?\s*.*법.*', s) and len(s)<25: continue # 장 머리글
            if re.fullmatch(r'[ⅠⅡⅢⅣⅤⅥⅦ]', s): continue
            if len(s)==1 and re.fullmatch(r'[가-힣]', s): continue  # 세로 머리글자
            lines.append(s)
    return lines

def parse_entries(lines):
    topic=''; ref=''
    entries=[]; cur=None
    i=0
    while i < len(lines):
        s=lines[i]
        m=re.match(r'^≫\s*(.*)$', s)
        if m is not None:
            if cur: entries.append(cur); cur=None
            topic=m.group(1).strip()
            if not topic and i+1<len(lines):
                i+=1; topic=lines[i].strip()
            ref=''
            if i+1<len(lines) and re.match(r'^\[.{2,60}\]$', lines[i+1]):
                i+=1; ref=lines[i].strip('[]')
            i+=1; continue
        if re.match(r'^질의\s*\d+', s):
            if cur: entries.append(cur)
            cur={'topic':topic,'ref':ref,'q':[s],'a':[],'mode':'q'}
            i+=1; continue
        if re.match(r'^회신\s*\d+', s) and cur:
            cur['mode']='a'; cur['a'].append(s); i+=1; continue
        if cur:
            cur[cur['mode']== 'q' and 'q' or 'a'].append(s)
        i+=1
    if cur: entries.append(cur)
    return entries

def main(inp, outp, year):
    doc=fitz.open(inp)
    booklet=None
    # 머리글(책자 제목) 추정: 첫 20페이지에서 가장 자주 반복되는 '질의회신집' 라인
    from collections import Counter
    c=Counter()
    for p in range(min(20,doc.page_count)):
        for ln in doc[p].get_text().split('\n'):
            if '질의회신집' in ln: c[ln.strip()]+=1
    booklet=c.most_common(1)[0][0] if c else '___'
    lines=clean_pages(doc, booklet)
    entries=parse_entries(lines)
    out=[]
    n=0
    for e in entries:
        q=' '.join(e['q']).strip(); a=' '.join(e['a']).strip()
        if len(q)<15 or len(a)<15: continue
        n+=1
        head=f"【주제】{e['topic']}" + (f" 【관련조문】{e['ref']}" if e['ref'] else '')
        out.append(f"{head}\n[질의] {q}\n[회신] {a}")
    fm=f"---\n제목: {year}년 소방시설법령 질의회신집(소방청)\n회신일자: {year}\n---\n"
    open(outp,'w',encoding='utf-8').write(fm + "\n===\n".join(out) + "\n")
    print(f"{inp} → {outp}: {n}건")

if __name__=='__main__':
    inp=sys.argv[1]; outp=sys.argv[2]
    y=re.search(r'(20\d{2})', inp).group(1)
    main(inp, outp, y)
