// ============================================================================
//  회귀 평가: 정답셋(eval/golden.jsonl)으로 "검색 재현율" 측정.
//  - 정답 조문/별표/키워드가 검색 상위 K에 드는지 확인 → 통과율 출력.
//  - Claude API 키 불필요(임베딩만 로컬 사용). 데이터/코드 바꿀 때마다 실행하세요.
//    실행: npm run eval
// ============================================================================
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TOPK = 12;

const SYNONYMS = {
  스프링쿨러: ["스프링클러설비"],
  스프링클러: ["스프링클러설비"],
  완강기: ["피난기구"],
  감지기: ["자동화재탐지설비"],
  소방시설법: ["소방시설 설치 및 관리에 관한 법률"],
  화재예방법: ["화재의 예방 및 안전관리에 관한 법률"],
};

const tokenize = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length >= 1);
function expanded(q) {
  const base = tokenize(q);
  const extra = [];
  for (const k of Object.keys(SYNONYMS)) if (q.includes(k)) for (const v of SYNONYMS[k]) extra.push(...tokenize(v));
  return new Set([...base, ...extra]);
}
function exactRefs(q) {
  const refs = [];
  for (const a of q.match(/제\s*\d+\s*조(?:의\s*\d+)?/g) || []) refs.push(a.replace(/\s+/g, ""));
  for (const b of q.match(/별표\s*\d+(?:의\s*\d+)?/g) || []) refs.push(b.replace(/\s+/g, ""));
  return refs;
}
const cos = (a, b) => {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
};

async function main() {
  const idxPath = path.join(ROOT, "data", "index.json");
  if (!fs.existsSync(idxPath)) {
    console.error("data/index.json 이 없습니다. 먼저 `npm run ingest` 를 실행하세요.");
    process.exit(1);
  }
  const { chunks } = JSON.parse(fs.readFileSync(idxPath, "utf-8"));
  const goldenPath = path.join(ROOT, "eval", "golden.jsonl");
  const golden = fs
    .readFileSync(goldenPath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  let embed = async () => null;
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", "Xenova/multilingual-e5-small");
    embed = async (t) => Array.from((await extractor("query: " + t, { pooling: "mean", normalize: true })).data);
  } catch {
    console.log("(임베딩 사용 불가 → 키워드 전용으로 평가)");
  }

  let pass = 0;
  const fails = [];

  for (const g of golden) {
    const qTokens = expanded(g.q);
    const refs = exactRefs(g.q);
    let qvec = null;
    try {
      qvec = await embed(g.q);
    } catch {}

    const scored = chunks
      .map((c) => {
        const hay = (c.text + " " + c.title + " " + (c.article || "")).toLowerCase();
        let kw = 0;
        for (const t of qTokens) if (hay.includes(t)) kw++;
        kw = qTokens.size ? kw / qTokens.size : 0;
        const vec = qvec && c.embedding ? (cos(qvec, c.embedding) + 1) / 2 : 0;
        let s = qvec && c.embedding ? 0.55 * vec + 0.45 * kw : kw;
        for (const r of refs) {
          if (c.article && c.article.replace(/\s+/g, "").includes(r)) s += 0.6;
          else if (c.text.replace(/\s+/g, "").includes(r)) s += 0.25;
        }
        return { c, s };
      })
      .sort((a, b) => b.s - a.s)
      .slice(0, TOPK)
      .map((x) => x.c);

    const ok = scored.some((c) => {
      if (g.expect_article && c.article && c.article.replace(/\s+/g, "").includes(g.expect_article.replace(/\s+/g, "")))
        return true;
      if (g.expect_title && c.title.includes(g.expect_title)) return true;
      if (g.expect_contains && (c.text + " " + (c.article || "")).replace(/\s+/g, "").includes(g.expect_contains.replace(/\s+/g, "")))
        return true;
      return false;
    });

    if (ok) pass++;
    else fails.push(g.q);
  }

  const rate = ((pass / golden.length) * 100).toFixed(1);
  console.log(`\n검색 재현율(Recall@${TOPK}): ${pass}/${golden.length} = ${rate}%`);
  if (fails.length) {
    console.log("\n❌ 미통과(정답 자료가 상위에 들지 못함 — 데이터/동의어/임베딩 점검 필요):");
    for (const f of fails) console.log("  - " + f);
  } else {
    console.log("✅ 전부 통과");
  }
  // 회귀 게이트: 통과율이 낮으면 비정상 종료(코드 1) → CI에서 배포 차단 가능
  if (pass / golden.length < 0.9) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
