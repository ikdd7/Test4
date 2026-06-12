// ============================================================================
//  인제스트: ./data 의 파일을 조문/별표/회신 단위로 청킹 + 메타데이터 + 임베딩
//  → data/index.json 생성. (로컬에서 `npm run ingest` 로 실행)
//
//  파일 넣는 법 (둘 중 아무거나):
//   (A) 가장 쉬움 — data/inbox/ 에 종류 상관없이 전부 넣기.
//       제목(<TITLE>)을 보고 법률/시행령/시행규칙/고시/질의회신 자동 분류.
//   (B) 직접 분류 — data/law, data/enforcement_decree, data/enforcement_rule,
//       data/appendix, data/notice, data/interpretation 폴더에 넣기.
//
//  지원 형식: .hwp/.hml(국가법령정보센터 HWPML) · .txt · .md
//  옵션: INGEST_NO_EMBED=1 npm run ingest  → 임베딩 생략(빠른 점검용)
//  ⚠ 인터넷 크롤링 금지 — 오직 ./data 파일만 근거로 사용합니다.
// ============================================================================
import fs from "node:fs";
import path from "node:path";

const EMBED_MODEL = "Xenova/multilingual-e5-small";
const ROOT = process.cwd();
const DATA = path.join(ROOT, "data");
const NO_EMBED = process.env.INGEST_NO_EMBED === "1";

const TYPE_MAP = {
  law: "법률",
  enforcement_decree: "시행령",
  enforcement_rule: "시행규칙",
  appendix: "별표",
  notice: "고시",
  interpretation: "질의회신",
};

// 제목으로 자료유형 자동 분류 (data/inbox 용)
function classifyByTitle(title) {
  const t = title || "";
  if (/질의|회신|법령해석|유권해석/.test(t)) return "질의회신";
  if (/고시|화재안전기준|성능기준|기술기준|NFPC|NFTC|NFSC|행정규칙|훈령|예규/i.test(t)) return "고시";
  if (/시행규칙/.test(t)) return "시행규칙";
  if (/시행령/.test(t)) return "시행령";
  if (/별표/.test(t)) return "별표";
  return "법률"; // 기본값(법률 본문)
}

// ── 유틸 ────────────────────────────────────────────────────────────────
function htmlUnescape(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function hwpmlExtract(raw) {
  const title = (raw.match(/<TITLE>([^<]*)<\/TITLE>/) || [])[1]?.trim() || null;
  const m = raw.match(/<BODY[^>]*>([\s\S]*)<\/BODY>/i);
  let b = m ? m[1] : raw;
  b = b.replace(/<\/P>/gi, "\n").replace(/<\/CELL>/gi, " ").replace(/<\/ROW>/gi, "\n");
  b = b.replace(/<[^>]+>/g, "");
  b = htmlUnescape(b);
  b = b.replace(/\{[^}]*\}/g, " ");
  b = b.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
  const sd = b.match(/\[시행\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\]/);
  const date = sd ? `${sd[1]}.${String(sd[2]).padStart(2, "0")}.${String(sd[3]).padStart(2, "0")}` : null;
  return { title, body: b, date };
}

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

// ── 청킹 ────────────────────────────────────────────────────────────────
function splitLaw(body) {
  const re = /(^|\n)[ \t]*(제\s*\d+\s*조(?:의\s*\d+)?|\[?\s*별표\s*\d+(?:\s*의\s*\d+)?\s*\]?)/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) {
    const pos = m.index + (m[1] ? m[1].length : 0);
    let label;
    if (m[2].includes("별표")) {
      const num = m[2].match(/\d+(?:\s*의\s*\d+)?/)[0].replace(/\s+/g, "");
      label = "별표 " + num;
    } else {
      label = m[2].replace(/\s+/g, "");
    }
    marks.push({ pos, label });
  }
  if (marks.length === 0) return [{ article: null, text: body.trim() }];
  const out = [];
  const pre = body.slice(0, marks[0].pos).trim();
  if (pre) out.push({ article: null, text: pre });
  for (let i = 0; i < marks.length; i++) {
    const s = marks[i].pos;
    const e = i + 1 < marks.length ? marks[i + 1].pos : body.length;
    const text = body.slice(s, e).trim();
    if (text) out.push({ article: marks[i].label, text });
  }
  return out;
}

function splitAppendix(body) {
  const re = /(^|\n)[ \t]*\[?\s*(별표\s*\d+(?:\s*의\s*\d+)?)\s*\]?/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) {
    const pos = m.index + (m[1] ? m[1].length : 0);
    const num = m[2].match(/\d+(?:\s*의\s*\d+)?/)[0].replace(/\s+/g, "");
    marks.push({ pos, label: "별표 " + num });
  }
  if (marks.length === 0) return [{ article: null, text: body.trim() }];
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const s = marks[i].pos;
    const e = i + 1 < marks.length ? marks[i + 1].pos : body.length;
    const text = body.slice(s, e).trim();
    if (text) out.push({ article: marks[i].label, text });
  }
  return out;
}

function splitInterpretation(body) {
  return body
    .split(/\n\s*={3,}\s*\n|\n\s*-{3,}\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ article: null, text: p }));
}

function chunkByType(type, body) {
  if (type === "별표") return splitAppendix(body);
  if (type === "질의회신") return splitInterpretation(body);
  return splitLaw(body);
}

function walk(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) files.push(...walk(full));
    else if (/\.(txt|md|hwp|hml)$/i.test(name)) files.push(full);
  }
  return files;
}

function inferParent(title) {
  if (!title) return null;
  if (title.includes("시행규칙")) return title.replace(/\s*시행규칙.*$/, "").trim();
  if (title.includes("시행령")) return title.replace(/\s*시행령.*$/, "").trim();
  return null;
}

// 파일 1개 → 청크들 push. folderType이 null이면 제목으로 자동 분류(inbox).
async function processFile(file, folderType, embed, chunks, dimRef) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const raw = fs.readFileSync(file, "utf-8");
  const base = path.basename(file).replace(/\.(txt|md|hwp|hml)$/i, "");
  const isHwpml = /\.(hwp|hml)$/i.test(file) || /<HWPML|<\?xml/i.test(raw.slice(0, 200));

  let title, body, date, parent, refNo;
  if (isHwpml) {
    const ex = hwpmlExtract(raw);
    title = ex.title || base;
    body = ex.body;
    date = ex.date || (base.match(/(\d{4})(\d{2})(\d{2})/) ? base.replace(/.*?(\d{4})(\d{2})(\d{2}).*/, "$1.$2.$3") : "미상");
    parent = inferParent(title);
    refNo = null;
  } else {
    const fm = parseFrontMatter(raw);
    title = fm.meta["법령명"] || fm.meta["제목"] || fm.meta["title"] || base;
    body = fm.body;
    date = fm.meta["시행일"] || fm.meta["회신일자"] || fm.meta["시행일자"] || fm.meta["date"] || "미상";
    parent = fm.meta["상위법"] || fm.meta["근거법"] || inferParent(title);
    refNo = fm.meta["회신번호"] || null;
  }

  const ftype = folderType || classifyByTitle(title);
  const pieces = chunkByType(ftype, body);
  let seq = 0;
  let count = 0;
  for (const piece of pieces) {
    const text = piece.text.trim();
    if (!text || text.length < 5) continue;
    const article = piece.article || (ftype === "질의회신" ? refNo || `회신-${++seq}` : null);
    const ctype = article && article.startsWith("별표") ? "별표" : ftype;

    let embedding = null;
    try {
      embedding = await embed(text);
      if (embedding && !dimRef.dim) dimRef.dim = embedding.length;
    } catch (e) {
      console.warn("임베딩 실패(키워드로 대체):", rel, e?.message);
    }

    chunks.push({
      id: `${base}:${article || "x"}:${chunks.length}`,
      type: ctype,
      title,
      article,
      date,
      parent,
      source_file: rel,
      text,
      embedding,
    });
    count++;
  }
  console.log(`  ✓ ${rel}  [${ftype}] ${title} → ${count} 청크 (시행일 ${date})`);
}

// ── 메인 ────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DATA)) {
    console.error("data 폴더가 없습니다:", DATA);
    process.exit(1);
  }

  let embed = async () => null;
  if (!NO_EMBED) {
    console.log("임베딩 모델 로딩:", EMBED_MODEL, "(최초 1회 다운로드)");
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", EMBED_MODEL);
    embed = async (text) => Array.from((await extractor("passage: " + text, { pooling: "mean", normalize: true })).data);
  } else {
    console.log("INGEST_NO_EMBED=1 → 임베딩 생략(키워드 검색만 동작).");
  }

  const chunks = [];
  const dimRef = { dim: 0 };

  // (A) data/inbox — 종류 자동 분류
  const inbox = path.join(DATA, "inbox");
  if (fs.existsSync(inbox)) {
    const files = walk(inbox);
    if (files.length) console.log(`[inbox] ${files.length}개 파일 자동 분류 중…`);
    for (const file of files) await processFile(file, null, embed, chunks, dimRef);
  }

  // (B) 종류별 폴더 — 폴더가 유형 결정
  for (const folder of Object.keys(TYPE_MAP)) {
    const dir = path.join(DATA, folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir)) await processFile(file, TYPE_MAP[folder], embed, chunks, dimRef);
  }

  const outPath = path.join(DATA, "index.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({ model: NO_EMBED ? "(none)" : EMBED_MODEL, dim: dimRef.dim, chunks }, null, 0),
    "utf-8"
  );
  console.log(`\n완료: ${chunks.length} 청크 → ${path.relative(ROOT, outPath)}`);
  if (chunks.length === 0) console.log("⚠ 청크 0건. data/inbox 또는 종류별 폴더에 파일을 넣었는지 확인하세요.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
