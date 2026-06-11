// ============================================================================
//  인제스트: ./data 의 파일을 조문/별표/회신 단위로 청킹 + 메타데이터 + 임베딩
//  → data/index.json 생성. (로컬에서 `npm run ingest` 로 실행)
//  ⚠ 인터넷 크롤링 금지 — 오직 ./data 파일만 근거로 사용합니다.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "@huggingface/transformers";

const EMBED_MODEL = "Xenova/multilingual-e5-small";
const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");

// 폴더명 → 자료유형
const TYPE_MAP = {
  law: "법률",
  enforcement_decree: "시행령",
  enforcement_rule: "시행규칙",
  appendix: "별표",
  notice: "고시",
  interpretation: "질의회신",
};

// --- 프론트매터 파서: 파일 맨 위 ---\nkey: value\n--- 블록 ---
function parseFrontMatter(raw) {
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end > 0) {
      const fm = raw.slice(3, end).trim();
      const body = raw.slice(end + 4).replace(/^\s*\n/, "");
      const meta = {};
      for (const line of fm.split("\n")) {
        const i = line.indexOf(":");
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return { meta, body };
    }
  }
  return { meta: {}, body: raw };
}

// 조문 단위 분할: "제13조", "제13조의2"
function splitArticles(body) {
  const re = /(제\s*\d+\s*조(?:의\s*\d+)?)/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ pos: m.index, label: m[1].replace(/\s+/g, "") });
  if (marks.length === 0) return [{ article: null, text: body.trim() }];
  const out = [];
  const pre = body.slice(0, marks[0].pos).trim();
  if (pre) out.push({ article: null, text: pre }); // 목적/총칙 등 머리말
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].pos;
    const end = i + 1 < marks.length ? marks[i + 1].pos : body.length;
    const text = body.slice(start, end).trim();
    if (text) out.push({ article: marks[i].label, text });
  }
  return out;
}

// 별표 단위 분할: "별표 4", "별표 4의2"
function splitAppendix(body) {
  const re = /(별표\s*\d+(?:\s*의\s*\d+)?)/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ pos: m.index, label: m[1].replace(/\s+/g, " ").trim() });
  if (marks.length === 0) return [{ article: null, text: body.trim() }];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].pos;
    const end = i + 1 < marks.length ? marks[i + 1].pos : body.length;
    const text = body.slice(start, end).trim();
    if (text) out.push({ article: marks[i].label, text });
  }
  return out;
}

// 질의회신 분할: === 또는 --- 로 구분된 건별. 없으면 파일 전체 1건.
function splitInterpretation(body) {
  const parts = body
    .split(/\n\s*={3,}\s*\n|\n\s*-{3,}\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => ({ article: null, text: p }));
}

function chunkFile(type, body, meta, relPath) {
  if (type === "별표") return splitAppendix(body);
  if (type === "질의회신") return splitInterpretation(body);
  // 법률/시행령/시행규칙/고시 → 조문 단위 (고시도 제N조 구조면 분할)
  return splitArticles(body);
}

function walk(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) files.push(...walk(full));
    else if (/\.(txt|md)$/i.test(name)) files.push(full);
  }
  return files;
}

async function main() {
  if (!fs.existsSync(DATA)) {
    console.error("data 폴더가 없습니다:", DATA);
    process.exit(1);
  }

  console.log("임베딩 모델 로딩:", EMBED_MODEL, "(최초 1회 다운로드)");
  const extractor = await pipeline("feature-extraction", EMBED_MODEL);
  const embed = async (text) => {
    const out = await extractor("passage: " + text, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  };

  const chunks = [];
  let dim = 0;

  for (const folder of Object.keys(TYPE_MAP)) {
    const dir = path.join(DATA, folder);
    if (!fs.existsSync(dir)) continue;
    const type = TYPE_MAP[folder];

    for (const file of walk(dir)) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const raw = fs.readFileSync(file, "utf-8");
      const { meta, body } = parseFrontMatter(raw);
      const base = path.basename(file).replace(/\.(txt|md)$/i, "");

      const title = meta["법령명"] || meta["제목"] || meta["title"] || base;
      const date =
        meta["시행일"] || meta["회신일자"] || meta["시행일자"] || meta["date"] || "미상";
      const parent = meta["상위법"] || meta["근거법"] || null;
      const refNo = meta["회신번호"] || null;

      const pieces = chunkFile(type, body, meta, rel);
      let seq = 0;
      for (const piece of pieces) {
        const article =
          piece.article || (type === "질의회신" ? refNo || `회신-${++seq}` : null);
        const text = piece.text.trim();
        if (!text) continue;

        let embedding = null;
        try {
          embedding = await embed(text);
          if (!dim) dim = embedding.length;
        } catch (e) {
          console.warn("임베딩 실패(키워드 검색으로 대체):", rel, e?.message);
        }

        chunks.push({
          id: `${folder}:${base}:${article || "x"}:${chunks.length}`,
          type,
          title,
          article,
          date,
          parent,
          source_file: rel,
          text,
          embedding,
        });
      }
      console.log(`  ✓ ${rel} → ${pieces.length} 청크`);
    }
  }

  const outPath = path.join(DATA, "index.json");
  fs.writeFileSync(outPath, JSON.stringify({ model: EMBED_MODEL, dim, chunks }, null, 0), "utf-8");
  console.log(`\n완료: ${chunks.length} 청크 → ${path.relative(ROOT, outPath)}`);
  if (chunks.length === 0) {
    console.log("⚠ 청크가 0건입니다. data 하위 폴더에 .txt/.md 파일을 넣었는지 확인하세요.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
