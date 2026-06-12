// 하이브리드 검색 + 정확 조회 + 동의어 확장. 계층 가로질러 통합.
import fs from "node:fs";
import path from "node:path";
import type { Chunk, Hit, IndexFile } from "./types";
import { embedQuery } from "./embed";

let cache: IndexFile | null = null;
let hayCache: string[] | null = null; // 청크별 소문자 검색대상 텍스트(본문+제목+조번호)
const dfCache = new Map<string, number>(); // 토큰별 문서빈도 캐시

function loadIndex(): IndexFile {
  if (cache) return cache;
  const p = path.join(process.cwd(), "data", "index.json");
  if (!fs.existsSync(p)) {
    cache = { model: "", dim: 0, chunks: [] };
    return cache;
  }
  cache = JSON.parse(fs.readFileSync(p, "utf-8")) as IndexFile;
  return cache;
}

function haystacks(): string[] {
  if (hayCache) return hayCache;
  hayCache = loadIndex().chunks.map((c) =>
    (c.text + " " + c.title + " " + (c.article || "")).toLowerCase()
  );
  return hayCache;
}

let titleCache: string[] | null = null; // 청크별 제목+조번호(필드 가중용)
function titleHays(): string[] {
  if (titleCache) return titleCache;
  titleCache = loadIndex().chunks.map((c) => (c.title + " " + (c.article || "")).toLowerCase());
  return titleCache;
}

// 토큰을 부분문자열로 포함하는 청크 수(한국어 조사 결합 대응 위해 부분일치 사용)
function docFreq(token: string): number {
  const cached = dfCache.get(token);
  if (cached !== undefined) return cached;
  let df = 0;
  for (const h of haystacks()) if (h.includes(token)) df++;
  dfCache.set(token, df);
  return df;
}

export function indexSize(): number {
  return loadIndex().chunks.length;
}

// 실무용어/약칭 → 법령용어 사전 (재현율 향상). 필요에 따라 계속 추가하세요.
const SYNONYMS: Record<string, string[]> = {
  스프링쿨러: ["스프링클러설비"],
  스프링클러: ["스프링클러설비"],
  완강기: ["피난기구"],
  소화기: ["소화기구"],
  감지기: ["자동화재탐지설비"],
  화재감지기: ["자동화재탐지설비"],
  경보기: ["비상경보설비", "자동화재탐지설비"],
  소방시설법: ["소방시설 설치 및 관리에 관한 법률"],
  화재예방법: ["화재의 예방 및 안전관리에 관한 법률"],
  소방관리자: ["소방안전관리자"],
  배연: ["제연설비"],
  방화문: ["방화구획"],
  비상구: ["피난구", "피난기구", "피난시설"],
};

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 1);
}

// 한국어 조사·어미 제거(긴 것 우선) — "과태료가"→"과태료", "비상구를"→"비상구".
// 원문은 조사가 다르게 붙어 있어, 질의어를 어간으로 만들어야 부분일치가 된다.
const PARTICLES = [
  "으로서", "으로써", "이라고", "라고는", "에서는", "으로", "이라는", "라는", "에서", "에게",
  "한테", "까지", "부터", "마저", "조차", "이나", "이란", "이라", "처럼", "보다", "만큼",
  "대로", "인가요", "입니까", "인가", "나요", "가요", "까요", "이고", "고요",
  "을", "를", "이", "가", "은", "는", "에", "의", "로", "와", "과", "도", "만", "나", "요",
];
function destem(tok: string): string {
  for (const p of PARTICLES) {
    if (tok.length > p.length + 1 && tok.endsWith(p)) return tok.slice(0, tok.length - p.length);
  }
  return tok;
}

// 질의 토큰 + 조사제거 어간 + 동의어 확장 토큰
function expandedTokens(query: string): string[] {
  const base = tokenize(query);
  const stems = base.map(destem).filter((t) => t.length >= 2);
  const extra: string[] = [];
  for (const key of Object.keys(SYNONYMS)) {
    if (query.includes(key)) for (const v of SYNONYMS[key]) extra.push(...tokenize(v));
  }
  return [...base, ...stems, ...extra];
}

function exactRefs(q: string): string[] {
  const refs: string[] = [];
  for (const a of q.match(/제\s*\d+\s*조(?:의\s*\d+)?/g) || []) refs.push(a.replace(/\s+/g, ""));
  for (const b of q.match(/별표\s*\d+(?:의\s*\d+)?/g) || []) refs.push(b.replace(/\s+/g, ""));
  return refs;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

// IDF 가중 키워드 점수: 흔한 단어보다 "과태료"처럼 희귀·결정적인 단어를 크게 반영.
// (기존엔 단순 일치 개수라 큰 문서가 흔한 단어를 많이 가졌다는 이유로 유리해지는 길이편향이 있었음)
// + 제목/조번호 일치는 추가 가중 — 별표 제목("과태료의 부과기준" 등)이 핵심 의도를 담으므로.
const TITLE_BOOST = 0.8;
function keywordScore(
  hay: string,
  titleHay: string,
  qTokens: string[],
  idf: Map<string, number>,
  idfTotal: number
): number {
  if (idfTotal <= 0) return 0;
  let num = 0;
  for (const t of qTokens) {
    const w = idf.get(t) || 0;
    if (!w) continue;
    if (hay.includes(t)) num += w;
    if (titleHay.includes(t)) num += w * TITLE_BOOST; // 제목 일치 시 추가
  }
  return num / idfTotal;
}

// ── 정확 조회: 법령명 + 조/별표 번호로 1:1 매칭 (의미검색보다 정확, 100% 보장) ──
export function lookupExact(lawName: string | undefined, article: string): Hit[] {
  const { chunks } = loadIndex();
  const a = (article || "").replace(/\s+/g, "");
  if (!a) return [];
  const lnTokens = tokenize(lawName || "");
  const res = chunks
    .filter((c) => {
      if (c.role === "child") return false; // 정확조회는 전체(부모)만 — 검색용 서브청크 제외
      const am = c.article ? c.article.replace(/\s+/g, "").includes(a) : false;
      const tm = lnTokens.length ? lnTokens.every((t) => c.title.toLowerCase().includes(t)) : true;
      return am && tm;
    })
    .map((c) => ({ ...c, score: 1 }));
  return res.slice(0, 30);
}

// ── 하이브리드 검색(키워드+동의어+벡터), 계층 가로지름 ──
export async function search(query: string, topK = 12): Promise<Hit[]> {
  const { chunks } = loadIndex();
  if (chunks.length === 0) return [];

  const qTokens = [...new Set(expandedTokens(query))];
  const refs = exactRefs(query);

  // 질의 토큰별 IDF 가중치(희귀어 우대) — 길이편향 제거의 핵심
  const N = chunks.length;
  const idf = new Map<string, number>();
  for (const t of qTokens) idf.set(t, Math.log(1 + N / (1 + docFreq(t))));
  const idfTotal = qTokens.reduce((s, t) => s + (idf.get(t) || 0), 0);

  let qvec: number[] | null = null;
  try {
    qvec = await embedQuery(query);
  } catch (e) {
    console.error("[search] query embedding failed, keyword-only fallback:", e);
  }

  const hays = haystacks();
  const tHays = titleHays();
  const scored: Hit[] = chunks.map((c, i) => {
    const kw = keywordScore(hays[i], tHays[i], qTokens, idf, idfTotal);
    const vec = qvec && c.embedding ? (cosine(qvec, c.embedding) + 1) / 2 : 0;
    let score = qvec && c.embedding ? 0.55 * vec + 0.45 * kw : kw;
    for (const r of refs) {
      const inArticle = c.article && c.article.replace(/\s+/g, "").includes(r);
      const inText = c.text.replace(/\s+/g, "").includes(r);
      if (inArticle) score += 0.6;
      else if (inText) score += 0.25;
    }
    // 질의회신·법령해석은 "보조 근거"라 약간 하향(법령이 우선 노출되도록)
    if (c.type === "질의회신" || c.type === "법령해석") score *= 0.8;
    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter((h) => h.score > 0);
}

const ORDER = ["법률", "시행령", "시행규칙", "별표", "고시", "법령해석", "질의회신"];
export function formatContext(hits: Hit[]): string {
  const sorted = [...hits].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  return sorted
    .map((h, i) => {
      const meta = [
        `자료유형: ${h.type}`,
        `명칭: ${h.title}`,
        h.article ? `조/번호: ${h.article}` : null,
        `시행일/회신일자: ${h.date}`,
        h.parent ? `상위법연결: ${h.parent}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return `[검색자료 ${i + 1}] ${meta}\n[조문 원문]\n${h.text}`;
    })
    .join("\n\n──────────\n\n");
}
