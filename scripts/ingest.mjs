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

// ── 계층청킹(별표) 설정 ──────────────────────────────────────────────────
//  큰 별표는 전체(parent)를 1청크로 유지하면서, 검색 정밀도를 위해
//  호(1.)→목(가.)→길이 순으로 "서브청크(child)"를 추가로 생성한다.
//  (작은 별표는 그대로 1청크 — 불필요한 분할 방지)
const APPENDIX_BIG = parseInt(process.env.APPENDIX_BIG || "2500", 10); // 이 글자수 이상이면 계층 분할
const SUB_MAX = parseInt(process.env.APPENDIX_SUB_MAX || "1600", 10); // 서브청크 1개 목표 상한
const SUB_MIN = parseInt(process.env.APPENDIX_SUB_MIN || "200", 10); // 이보다 작은 조각은 직전과 병합

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

// ── 계층청킹: 큰 별표를 검색용 서브청크로 분할 ──────────────────────────
// 마커(호/목)로 1차 분할. 마커가 2개 미만이면 분할 의미가 없어 null 반환.
// 마커 앞 도입부(적용범위·캡션 등)는 "도입" 조각으로 따로 살린다.
function splitMarkers(text, re, fmt) {
  re.lastIndex = 0;
  const marks = [];
  let m;
  while ((m = re.exec(text))) marks.push({ pos: m.index + (m[1] ? m[1].length : 0), label: fmt(m) });
  if (marks.length < 2) return null;
  const out = [];
  const pre = text.slice(0, marks[0].pos).trim();
  if (pre && pre.length >= SUB_MIN) out.push({ path: "도입", text: pre });
  for (let i = 0; i < marks.length; i++) {
    const s = marks[i].pos;
    const e = i + 1 < marks.length ? marks[i + 1].pos : text.length;
    const t = text.slice(s, e).trim();
    if (t) out.push({ path: marks[i].label, text: t });
  }
  return out;
}

// 마커가 없을 만큼 큰 조각은 줄 경계 기준 길이로 강제 분할.
function hardWrap(piece) {
  const out = [];
  let buf = "";
  for (const ln of piece.text.split("\n")) {
    if (buf && buf.length + ln.length > SUB_MAX) {
      out.push(buf.trim());
      buf = "";
    }
    buf += ln + "\n";
  }
  if (buf.trim()) out.push(buf.trim());
  return out.map((t, i) => ({ path: piece.path + (out.length > 1 ? ` (${i + 1})` : ""), text: t }));
}

// 너무 작은 조각은 직전 조각에 병합(파편화 방지).
function mergeSmall(arr) {
  const out = [];
  for (const p of arr) {
    if (out.length && p.text.length < SUB_MIN) {
      const prev = out[out.length - 1];
      out[out.length - 1] = { path: prev.path, text: prev.text + "\n" + p.text };
    } else out.push(p);
  }
  return out;
}

// 제목에서 별표 라벨("별표 4") 추출 — 별표 txt는 번호가 본문 줄 중간에 있어
// splitAppendix가 못 잡으므로(article=null), 제목/캡션으로 보완한다.
function appendixLabelFromTitle(title) {
  const m = (title || "").match(/별표\s*(\d+(?:\s*의\s*\d+)?)/);
  return m ? "별표 " + m[1].replace(/\s+/g, "") : null;
}

// 제목에서 한 줄 캡션(설명명) 추출 — 서브청크 헤더에 붙여 맥락 보존.
function appendixCaption(title) {
  let cap = (title || "").replace(/^\[?\s*별표\s*\d+(?:\s*의\s*\d+)?\s*\]?/, "").trim();
  cap = cap.replace(/\(제[^)]*관련\).*$/, "").trim(); // "(제11조 관련)(법령명)" 꼬리 제거
  return cap.length > 60 ? cap.slice(0, 60) : cap;
}

// 별표 전체 텍스트 → 서브청크 [{path, text}]. (호 → 목 → 길이 순으로 내려감)
function subdivideAppendix(text) {
  const ho = splitMarkers(text, /(^|\n)[ \t]*(\d{1,2})\.[ \t]/g, (m) => m[2] + "호");
  const level1 = ho || [{ path: "", text }];
  const out = [];
  for (const p of level1) {
    if (p.text.length <= SUB_MAX) {
      out.push(p);
      continue;
    }
    const mok = splitMarkers(p.text, /(^|\n)[ \t]*([가-하])\.[ \t]/g, (m) => m[2] + "목");
    if (!mok) {
      out.push(...hardWrap(p));
      continue;
    }
    for (const q of mok) {
      const merged = { path: [p.path, q.path].filter(Boolean).join(" "), text: q.text };
      if (merged.text.length <= SUB_MAX) out.push(merged);
      else out.push(...hardWrap(merged));
    }
  }
  return mergeSmall(out);
}

function splitInterpretation(body) {
  return body
    .split(/\n\s*={3,}\s*\n|\n\s*-{3,}\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ article: null, text: p }));
}

// 고시(화재안전기술기준 NFTC) 청킹: "1.1 적용범위", "2.4 감지기" 같은 십진 소절 단위.
// (제○조가 아니라 N.N 머리표로 나눔. N.N.N 클라우즈는 소절 안에 포함)
function splitNotice(body) {
  const re = /(^|\n)[ \t]*(\d+\.\d+)\s+(?=\S)/g; // "1.1"·"2.4" 소절만(표 안 "2." 단독, "2.4.1" 클라우즈는 매칭 안 됨)
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ pos: m.index + (m[1] ? m[1].length : 0), label: m[2] });
  if (marks.length === 0) return [{ article: null, text: body.trim() }];
  const raw = [];
  const pre = body.slice(0, marks[0].pos).trim();
  if (pre) raw.push({ article: null, text: pre });
  for (let i = 0; i < marks.length; i++) {
    const s = marks[i].pos;
    const e = i + 1 < marks.length ? marks[i + 1].pos : body.length;
    const t = body.slice(s, e).trim();
    if (t) raw.push({ article: marks[i].label, text: t });
  }
  // 머리글만 있는 짧은 상위 섹션(예: "1. 일반사항", "2. 기술기준")은 다음 청크 앞에 합침
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c.text.length < 24 && i + 1 < raw.length) {
      raw[i + 1] = { article: raw[i + 1].article, text: c.text + "\n" + raw[i + 1].text };
    } else {
      out.push(c);
    }
  }
  return out;
}

function chunkByType(type, body) {
  if (type === "별표") return splitAppendix(body);
  if (type === "질의회신") return splitInterpretation(body);
  if (type === "고시") return splitNotice(body);
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

  // 청크 1건 embed + push → 생성된 id 반환
  const pushChunk = async (o) => {
    let embedding = null;
    try {
      embedding = await embed(o.text);
      if (embedding && !dimRef.dim) dimRef.dim = embedding.length;
    } catch (e) {
      console.warn("임베딩 실패(키워드로 대체):", rel, e?.message);
    }
    const id = `${base}:${o.article || "x"}:${chunks.length}`;
    chunks.push({
      id,
      type: o.type,
      title,
      article: o.article,
      date,
      parent,
      source_file: rel,
      text: o.text,
      embedding,
      role: o.role ?? null,
      parent_id: o.parent_id ?? null,
    });
    count++;
    return id;
  };

  for (const piece of pieces) {
    const text = piece.text.trim();
    if (!text || text.length < 5) continue;
    let article = piece.article || (ftype === "질의회신" ? refNo || `회신-${++seq}` : null);
    const ctype = (article && article.startsWith("별표")) || ftype === "별표" ? "별표" : ftype;
    // 별표인데 마커로 번호를 못 잡은 경우(article=null) 제목에서 보완 → 정확조회 가능해짐
    if (ctype === "별표" && !article) article = appendixLabelFromTitle(title);

    // 부모 청크(별표는 전체를 1청크로 유지 — 표 경계·단서 보존 + 정확조회용)
    const parentId = await pushChunk({
      type: ctype,
      article,
      text,
      role: ctype === "별표" ? "parent" : null,
    });

    // 큰 별표만 검색 정밀도용 서브청크(child) 추가
    if (ctype === "별표" && text.length >= APPENDIX_BIG) {
      const caption = appendixCaption(title);
      const subs = subdivideAppendix(text);
      if (subs.length > 1) {
        for (const sub of subs) {
          const header = `[${article || "별표"}] ${caption}${sub.path ? " > " + sub.path : ""}`.trim();
          await pushChunk({
            type: ctype,
            article: `${article}${sub.path ? " " + sub.path : ""}`.trim(),
            text: header + "\n" + sub.text,
            role: "child",
            parent_id: parentId,
          });
        }
      }
    }
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
