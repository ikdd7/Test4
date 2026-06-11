// 하이브리드 검색: 키워드(정확) + 벡터(의미). 계층을 가로질러 통합 검색.
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

// 한글/영문/숫자 토큰화 (특수문자 제거)
function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 1);
}

// 질의에서 정확 참조 패턴 추출: "제13조", "제13조의2", "별표 4"
function exactRefs(q: string): string[] {
  const refs: string[] = [];
  const art = q.match(/제\s*\d+\s*조(?:의\s*\d+)?/g) || [];
  const bp = q.match(/별표\s*\d+(?:의\d+)?/g) || [];
  for (const a of art) refs.push(a.replace(/\s+/g, ""));
  for (const b of bp) refs.push(b.replace(/\s+/g, " ").trim());
  return refs;
}

function cosine(a: number[], b: number[]): number {
  // 벡터는 정규화되어 있으므로 내적 = 코사인 유사도
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

function keywordScore(chunk: Chunk, qTokens: string[]): number {
  if (qTokens.length === 0) return 0;
  const hay = (chunk.text + " " + chunk.title + " " + (chunk.article || "")).toLowerCase();
  let hit = 0;
  for (const t of new Set(qTokens)) {
    if (hay.includes(t)) hit++;
  }
  return hit / new Set(qTokens).size; // 0~1
}

export async function search(query: string, topK = 12): Promise<Hit[]> {
  const { chunks } = loadIndex();
  if (chunks.length === 0) return [];

  const qTokens = tokenize(query);
  const refs = exactRefs(query);

  // 질의 임베딩(베스트에포트). 실패하면 키워드 전용으로 정상 동작.
  let qvec: number[] | null = null;
  try {
    qvec = await embedQuery(query);
  } catch (e) {
    console.error("[search] query embedding failed, falling back to keyword-only:", e);
  }

  const scored: Hit[] = chunks.map((c) => {
    const kw = keywordScore(c, qTokens);
    const vec = qvec && c.embedding ? (cosine(qvec, c.embedding) + 1) / 2 : 0; // 0~1
    let score = qvec && c.embedding ? 0.55 * vec + 0.45 * kw : kw;

    // 정확 참조 부스트: "제13조" / "별표 4" 가 청크의 조번호/별표번호 또는 본문에 있으면 가산
    for (const r of refs) {
      const inArticle = c.article && c.article.replace(/\s+/g, "").includes(r.replace(/\s+/g, ""));
      const inText = c.text.replace(/\s+/g, "").includes(r.replace(/\s+/g, ""));
      if (inArticle) score += 0.6;
      else if (inText) score += 0.25;
    }
    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).filter((h) => h.score > 0);
}

// 효력 위계 순으로 검색결과를 컨텍스트 문자열로 포맷 (모델에 전달)
const ORDER = ["법률", "시행령", "시행규칙", "별표", "고시", "법령해석", "질의회신"];
export function formatContext(hits: Hit[]): string {
  const sorted = [...hits].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type));
  const blocks = sorted.map((h, i) => {
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
  });
  return blocks.join("\n\n──────────\n\n");
}
