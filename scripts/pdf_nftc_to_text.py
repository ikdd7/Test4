#!/usr/bin/env python3
# 화재안전기술기준(NFTC) PDF → 고시 텍스트 변환기
# data/inbox 의 NFTC PDF들을 data/notice/*.txt 로 변환(프론트매터 + 십진 조항 본문).
# 사용: pip3 install pymupdf;  python3 scripts/pdf_nftc_to_text.py
import fitz, glob, re, os

INBOX = "data/inbox"
OUT = "data/notice"
os.makedirs(OUT, exist_ok=True)


def title_from_filename(fn):
    base = os.path.basename(fn)
    base = re.sub(r"\.pdf$", "", base, flags=re.I)
    base = re.sub(r"^\([^)]*\)\s*\+?", "", base)  # "(...공고 제2026-10호)+" 제거
    base = base.replace("+", " ")
    base = re.sub(r"\s+", " ", base).strip()
    base = re.sub(r"\(\s*NFTC\s*", "(NFTC ", base)  # "(NFTC 203)" 정규화
    return base


def nftc_code(title):
    m = re.search(r"NFTC\s*([0-9A-Za-z]+)", title)
    return m.group(1) if m else "X"


def convert(fn):
    title = title_from_filename(fn)
    code = nftc_code(title)
    doc = fitz.open(fn)
    raw = []
    for p in range(doc.page_count):
        for ln in doc[p].get_text().split("\n"):
            raw.append(ln.strip())

    # 시행일: 제·개정이력 등에 등장하는 날짜 중 가장 최근
    dates = re.findall(r"(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.", " ".join(raw))
    eff = "미상"
    if dates:
        y, m, d = sorted(dates, key=lambda t: (int(t[0]), int(t[1]), int(t[2])))[-1]
        eff = f"{y}.{int(m):02d}.{int(d):02d}"

    spaceless_title = re.sub(r"\s", "", title)
    body = []
    started = False
    for s in raw:
        if not s:
            continue
        if not started:
            # 목차·이력 건너뛰고, 점선 없는 첫 "1. " 본문 제목에서 시작
            if re.match(r"^1\.\s", s) and "·" not in s and "…" not in s:
                started = True
            else:
                continue
        if re.fullmatch(r"-?\s*\d{1,3}\s*-?", s):  # 페이지번호 "- 1 -" / "1"
            continue
        if s.startswith("- ") and s.endswith(" -"):
            continue
        if "이하여백" in s:
            continue
        if "·····" in s or "………" in s:  # 목차 점선
            continue
        if re.sub(r"\s", "", s) == spaceless_title:  # 페이지 머리글(반복 제목)
            continue
        body.append(s)

    if not body:
        return None
    fm = f"---\n제목: {title}\n시행일: {eff}\n상위법: 소방시설 설치 및 관리에 관한 법률\n---\n"
    text = fm + "\n".join(body) + "\n"
    safe = re.sub(r"[^0-9A-Za-z가-힣]+", "_", title)[:50].strip("_")
    out_path = os.path.join(OUT, f"NFTC_{code}_{safe}.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(text)
    return out_path, len(body)


def main():
    pdfs = sorted(glob.glob(os.path.join(INBOX, "*.pdf")))
    nftc = [p for p in pdfs if "NFTC" in os.path.basename(p)]
    print(f"NFTC PDF {len(nftc)}개 변환 중...")
    n = 0
    for p in nftc:
        r = convert(p)
        if r:
            n += 1
            print(f"  ✓ {os.path.basename(r[0])}  ({r[1]} 줄)")
        else:
            print(f"  ✗ 본문 추출 실패: {os.path.basename(p)}")
    print(f"완료: {n}/{len(nftc)} → {OUT}")


if __name__ == "__main__":
    main()
