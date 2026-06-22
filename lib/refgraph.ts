// 참조 엣지 확장 + 허브 강제포함 — "GraphRAG의 순회 발상"을 비싼 그래프 구축 없이 구현.
// 법조문엔 "별표 5", "제13조" 같은 엣지가 본문에 이미 박혀 있으므로, 그걸 따라가 원문을 동봉한다.
// 핵심: 별표/조 번호는 법마다 중복되므로(별표 5만 4종) 반드시 "출발 조문과 같은 법령"으로 스코프한다.
import type { Hit } from "./types";
import { lookupExact } from "./search";

const REF_RX: RegExp[] = [
  /별표\s*\d+(?:의\s*\d+)?/g,
  /제\s*\d+\s*조(?:의\s*\d+)?/g,
];

// 본문에서 가리키는 참조(별표 N/제N조)를 정규화해 추출.
export function extractRefs(text: string): string[] {
  const out = new Set<string>();
  for (const re of REF_RX) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const b = m[0].match(/별표\s*\d+(?:의\s*\d+)?/);
      const a = m[0].match(/제\s*\d+\s*조(?:의\s*\d+)?/);
      if (b) out.add(b[0].replace(/\s+/g, " ").trim());
      else if (a) out.add(a[0].replace(/\s+/g, ""));
    }
  }
  return [...out];
}

// 같은 별표/조의 중복(짧은 stub + 본문) 정리: 번호별로 본문이 가장 긴 1건만 남김.
//  주의: 호출부가 lookupExact로 "단일 법령"에 한정해 넘기므로, 번호(article)만으로 묶어도 안전하다.
//  (같은 별표가 "법령명 제목 stub" + "[별표 N]…(법령명) 본문" 두 형식으로 중복 저장돼 있음)
function preferLongest(hits: Hit[]): Hit[] {
  const best = new Map<string, Hit>();
  for (const h of hits) {
    const key = (h.article || "").replace(/\s+/g, "");
    const cur = best.get(key);
    if (!cur || (h.text?.length || 0) > (cur.text?.length || 0)) best.set(key, h);
  }
  return [...best.values()];
}

// 출발 조문(법령 타입)들이 가리키는 참조를 "같은 법령 안에서" 끌어와 후보로 반환.
//  seeds: 상위 조문(법령) / scoreFloor: 추가분에 부여할 보조 점수(원래 풀과 경쟁은 하되 과대평가 방지)
export function expandReferences(
  seeds: Hit[],
  opts: { maxSeeds?: number; maxAddPerSeed?: number; scoreFactor?: number } = {}
): Hit[] {
  const maxSeeds = opts.maxSeeds ?? 6;
  const maxAddPerSeed = opts.maxAddPerSeed ?? 3;
  const scoreFactor = opts.scoreFactor ?? 0.85;
  const added: Hit[] = [];
  const seen = new Set(seeds.map((h) => h.id));
  for (const seed of seeds.slice(0, maxSeeds)) {
    const refs = extractRefs(seed.text);
    let n = 0;
    for (const r of refs) {
      if (n >= maxAddPerSeed) break;
      // 같은 법령으로 스코프: seed.title(법령명)을 lawName으로 넘겨 동일 법 안에서만 조회
      const hits = preferLongest(lookupExact(seed.title, r));
      for (const h of hits) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        added.push({ ...h, score: (seed.score || 0) * scoreFactor });
        n++;
        if (n >= maxAddPerSeed) break;
      }
    }
  }
  return added;
}

// ── 허브 강제포함 ──────────────────────────────────────────────────────
// 판정에 구조적으로 핵심이지만 키워드가 잘 안 잡혀 만성적으로 밀리는 "허브 별표" 안전망.
// 케이스마다 늘리지 않는다(두더지잡기 금지). 질문 유형이 맞을 때만 순위 무관 동봉.
interface Hub {
  test: RegExp;
  law: string; // lookupExact lawName (모든 토큰이 조문 title에 있어야 매칭됨)
  article: string;
  why: string;
}
const HUBS: Hub[] = [
  {
    test: /자체점검|작동점검|종합점검|점검\s*대상|점검\s*해야|점검\s*받/,
    law: "소방시설 설치 및 관리에 관한 법률 시행규칙",
    article: "별표 3",
    why: "자체점검 구분·대상",
  },
  {
    // "어떤 소방설비를 설치해야 하나"류에만(14k자 대형표라 흔한 '대상'엔 끌려나오지 않게 좁힘)
    test: /소방시설.{0,4}설치|설치.{0,6}소방시설|설치\s*대상|설치해야|어떤\s*(소방)?설비|무슨\s*설비/,
    law: "소방시설 설치 및 관리에 관한 법률 시행령",
    article: "별표 4",
    why: "설치해야 하는 소방시설의 종류",
  },
  {
    // 면제·대체·자체점검·설치 판정엔 면제기준을 항상 확인(3.5k자, 대체 판정의 핵심)
    test: /면제|대체|갈음|자체점검|설치/,
    law: "소방시설 설치 및 관리에 관한 법률 시행령",
    article: "별표 5",
    why: "소방시설 설치의 면제 기준(대체 판정의 핵심)",
  },
  {
    test: /선임|등급|소방안전관리자|관리대상물/,
    law: "화재의 예방 및 안전관리에 관한 법률 시행령",
    article: "별표 4",
    why: "소방안전관리자 선임 등급",
  },
];

// 질문 유형에 맞는 허브 별표 원문(본문 긴 것 1건씩)을 반환.
export function forceIncludeHubs(query: string): Hit[] {
  const out: Hit[] = [];
  const seen = new Set<string>();
  for (const hub of HUBS) {
    if (!hub.test.test(query)) continue;
    const hits = preferLongest(lookupExact(hub.law, hub.article));
    for (const h of hits) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      out.push(h);
    }
  }
  return out;
}
