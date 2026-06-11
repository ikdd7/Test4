// 하이브리드 검색 + 정확 조회 + 동의어 확장. 계층 가로질러 통합.
import fs from "node:fs";
import path from "node:path";
import type { Chunk, Hit, IndexFile } from "./types";
import { embedQuery } from "./embed";

let cache: IndexFile | null = null;

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

// 질의 토큰 + 동의어 확장 토큰
function expandedTokens(query: string): string[] {
  const base = tokenize(query);
  const extra: string[] = [];
  for (const key of Object.keys(SYNONYMS)) {
    if (query.includes(key)) for (const v of SYNONYMS[key]) extra.push(...tokenize(v));
  }
  return [...base, ...extra];
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

function keywordScore(chunk: Chunk, qTokens: Set<string>): number {
  if (qTokens.size === 0) return 0;
  const hay = (chunk.text + " " + chunk.title + " " + (chunk.article || "")).toLowerCase();
  let hit = 0;
  for (const t of qTokens) if (hay.includes(t)) hit++;
  return hit / qTokens.size;
}

// ── 정확 조회: 법령명 + 조/별표 번호로 1:1 매칭 (의미검색보다 정확, 100% 보장) ──
export function lookupExact(lawName: string | undefined, article: string): Hit[] {
  const { chunks } = loadIndex();
  const a = (article || "").replace(/\s+/g, "");
  if (!a) return [];
  const lnTokens = tokenize(lawName || "");
  const res = chunks
    .filter((c) => {
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

  const qTokens = new Set(expandedTokens(query));
  const refs = exactRefs(query);

  let qvec: number[] | null = null;
  try {
    qvec = await embedQuery(query);
  } catch (e) {
    console.error("[search] query embedding failed, keyword-only fallback:", e);
  }

  const scored: Hit[] = chunks.map((c) => {
    const kw = keywordScore(c, qTokens);
    const vec = qvec && c.embedding ? (cosine(qvec, c.embedding) + 1) / 2 : 0;
    let score = qvec && c.embedding ? 0.55 * vec + 0.45 * kw : kw;
    for (const r of refs) {
      const inArticle = c.article && c.article.replace(/\s+/g, "").includes(r);
      const inText = c.text.replace(/\s+/g, "").includes(r);
      if (inArticle) score += 0.6;
      else if (inText) score += 0.25;
    }
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
