// 휴리스틱 리랭커 — 추가 모델·API 없이 신호를 결합해 후보를 재정렬한다.
// 흐름: 1차 검색(재현율 위주로 넉넉히) → 여기서 질의 적합도로 재점수 → 상위 소수만 LLM(정밀도).
// 목적: 핵심 조문이 가운데(혹은 상한 밖)에 묻히는 "lost in the middle"을 줄이고,
//       질의의 "여러 핵심어를 두루 충족하는" 조문을 위로 끌어올린다.
import type { Hit } from "./types";

// 효력위계 prior — 동점 부근에서 법령(구속력)을 해석례보다 살짝 우대.
const TYPE_PRIOR: Record<string, number> = {
  법률: 1.0,
  시행령: 1.0,
  시행규칙: 0.98,
  별표: 1.0,
  고시: 0.95,
  법령해석: 0.82,
  질의회신: 0.8,
};

// 질의 핵심어 커버리지: 청크가 "서로 다른 질의어를 몇 종류나" 담는지(0~1).
//  제목/조번호 일치는 가중(의도를 담는 필드), 본문 일치는 부분 가중. 단어당 1회만 계상(길이편향 방지).
function coverage(hit: Hit, terms: string[]): number {
  if (terms.length === 0) return 0;
  const body = (hit.text || "").toLowerCase();
  const title = (hit.title + " " + (hit.article || "")).toLowerCase();
  let sum = 0;
  for (const t of terms) {
    if (title.includes(t)) sum += 1.0;
    else if (body.includes(t)) sum += 0.7;
  }
  return Math.min(1, sum / terms.length);
}

export interface RerankOpts {
  // 질의에 명시된 참조(예: "별표 5", "제13조") — 해당 조문에 가산
  refs?: string[];
  // 가중치(필요 시 튜닝). 합이 1일 필요는 없음.
  wBase?: number;
  wCover?: number;
  wType?: number;
  wRef?: number;
}

// 후보를 재정렬해 rerankScore가 큰 순으로 반환(원본 score는 보존).
export function rerank(hits: Hit[], terms: string[], opts: RerankOpts = {}): Hit[] {
  if (hits.length === 0) return hits;
  const wBase = opts.wBase ?? 0.45;
  const wCover = opts.wCover ?? 0.35;
  const wType = opts.wType ?? 0.12;
  const wRef = opts.wRef ?? 0.08;
  const refs = (opts.refs || []).map((r) => r.replace(/\s+/g, ""));

  const maxScore = Math.max(...hits.map((h) => h.score), 1e-9);

  const scored = hits.map((h) => {
    const baseNorm = h.score / maxScore;
    const cov = coverage(h, terms);
    const typePrior = TYPE_PRIOR[h.type] ?? 0.9;
    let refBonus = 0;
    if (refs.length) {
      const art = (h.article || "").replace(/\s+/g, "");
      const txt = (h.text || "").replace(/\s+/g, "");
      for (const r of refs) {
        if (art.includes(r)) { refBonus = 1; break; }
        if (txt.includes(r)) refBonus = Math.max(refBonus, 0.5);
      }
    }
    let rr = wBase * baseNorm + wCover * cov + wType * typePrior + wRef * refBonus;
    // 본문이 거의 없는 헤더 stub(예: 별표 제목만 39자)은 컨텍스트로 무가치 → 강등
    if ((h.text || "").length < 120) rr *= 0.4;
    return { hit: h, rr };
  });

  scored.sort((a, b) => b.rr - a.rr);
  return scored.map((s) => s.hit);
}
