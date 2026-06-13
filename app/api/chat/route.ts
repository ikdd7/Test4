import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { search, lookupExact, formatContext, indexSize } from "@/lib/search";
import { SYSTEM_PROMPT, AGENT_INSTRUCTION, VERIFY_PROMPT, DISCLAIMER } from "@/lib/prompt";
import type { Hit } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 신뢰성 우선 파이프라인(다단계 검색 + 검증)은 시간이 걸립니다.
// Vercel Pro=최대 300s, Hobby(무료)=60s 상한이 적용됩니다.
export const maxDuration = 300;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-fable-5";
const MAX_SEARCH_ROUNDS = 6; // 에이전트가 검색을 반복할 최대 횟수
const PER_SEARCH_TOPK = 8;

type Msg = { role: "user" | "assistant"; content: any };

const SEARCH_TOOL = {
  name: "search_law",
  description:
    "소방 법령 데이터(법률/시행령/시행규칙/별표/고시/질의회신·법령해석)에서 개념·조건·키워드로 의미검색한다. 질문을 분해해 여러 번 호출하고, 본문에 나온 참조(별표 N, 법 제N조 등)도 추가로 따라갈 것.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "검색어. 가능하면 정식 법령 용어로(예: '스프링클러설비 설치대상', '소방안전관리자 선임').",
      },
    },
    required: ["query"],
  },
};

const LOOKUP_TOOL = {
  name: "lookup_article",
  description:
    "법령명+조번호 또는 별표번호로 정확히 1:1 조회한다(의미검색보다 정확·확정적). '제13조', '별표 4' 같은 명시적 참조가 있으면 반드시 이 도구를 우선 사용할 것.",
  input_schema: {
    type: "object",
    properties: {
      law_name: {
        type: "string",
        description: "법령명(선택). 예: 소방시설 설치 및 관리에 관한 법률 / 시행령 / 시행규칙",
      },
      article: {
        type: "string",
        description: "조번호 또는 별표번호. 예: 제13조, 제24조, 별표 4",
      },
    },
    required: ["article"],
  },
};

const TOOLS = [SEARCH_TOOL, LOOKUP_TOOL];

function textOf(content: any[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// 답변이 언급한 조/별표가 실제 검색자료에 있는지 기계적으로 대조
function citationGaps(answer: string, served: Hit[]): string[] {
  const refs = new Set<string>();
  for (const m of answer.matchAll(/제\s*\d+\s*조(?:의\s*\d+)?/g)) refs.add(m[0].replace(/\s+/g, ""));
  for (const m of answer.matchAll(/별표\s*\d+(?:의\s*\d+)?/g)) refs.add(m[0].replace(/\s+/g, ""));
  const hay = served
    .map((s) => (s.article || "") + " " + s.text)
    .join(" ")
    .replace(/\s+/g, "");
  const gaps: string[] = [];
  for (const r of refs) if (!hay.includes(r)) gaps.push(r);
  return gaps;
}

// «» 로 표시된 원문 인용이 검색자료에 "글자 단위로" 실재하는지 검증
function verifyQuotes(answer: string, served: Hit[]): string[] {
  // 공백 + 마크다운 강조/머리표(**굵게**, *기울임*, `코드`, #, > 등)를 제거해
  // LLM이 인용에 넣은 서식 때문에 멀쩡한 인용이 "불일치"로 오탐되는 것을 방지.
  const norm = (s: string) => s.replace(/[\s*_`#>~\[\]]/g, "");
  const hay = norm(served.map((s) => s.text).join("\n"));
  const quotes = [...answer.matchAll(/«([^»]{6,})»/g)].map((m) => m[1]);
  const unverified: string[] = [];
  for (const q of quotes) {
    if (!hay.includes(norm(q))) unverified.push(q.length > 60 ? q.slice(0, 60) + "…" : q);
  }
  return unverified;
}

// ── 검색 전용 모드(LLM 미사용): 원문만 효력위계대로 그대로 출력 ──
function refsFrom(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/제\s*\d+\s*조(?:의\s*\d+)?/g)) out.push(m[0].replace(/\s+/g, ""));
  for (const m of q.matchAll(/별표\s*\d+(?:의\s*\d+)?/g)) out.push(m[0].replace(/\s+/g, " ").trim());
  return out;
}

async function buildSearchOnly(query: string) {
  // Gemini 경로와 동일한 "법령 최소 보장" 선택 로직을 재사용 — 검색 전용/강등 시에도
  // 권위 있는 법령(별표·조문)이 수다스러운 질의회신에 밀려 누락되지 않게 한다.
  const { served } = await retrieveForRead(query);
  // 표시용: 검색 정밀도용 자식 서브청크(child)는 빼고 부모(별표 전체)/조문만 노출
  const visible = served.filter((h) => h.role !== "child").sort((a, b) => b.score - a.score);
  const isLaw = (t: string) => ["법률", "시행령", "시행규칙", "별표", "고시"].includes(t);
  const lawHits = visible.filter((h) => isLaw(h.type)).slice(0, 6);
  const interpHits = visible.filter((h) => !isLaw(h.type)).slice(0, 2);
  const top = [...lawHits, ...interpHits];
  const fmt = (h: Hit) => {
    const head = `▸ [${h.type}] ${h.title}${h.article ? " " + h.article : ""} (시행 ${h.date})`;
    const oneText = h.text.replace(/\s+/g, " ").trim();
    const body = oneText.length > 600 ? oneText.slice(0, 600) + " …(이하 생략 — 원문 확인 필요)" : oneText;
    return `${head}\n${body}`;
  };
  const law = top.filter((h) => isLaw(h.type));
  const interp = top.filter((h) => !isLaw(h.type));

  let body = "🔎 검색 전용 모드입니다(LLM 미사용). 검색된 근거 원문을 요약 표시합니다.\n";
  body += "정식 해석·답변을 보려면 GEMINI_API_KEY(무료)를 설정하세요.\n\n";
  if (top.length === 0) {
    body += "검색된 자료에 없습니다.\n\n";
  } else {
    body += "■ [법령 근거]\n" + (law.length ? law.map(fmt).join("\n\n") : "(없음)") + "\n";
    if (interp.length) body += "\n■ [해석·참고] (개정으로 달라졌을 수 있음)\n" + interp.map(fmt).join("\n\n") + "\n";
  }
  body += `\n※ ${DISCLAIMER}`;
  return {
    answer: body,
    mode: "search",
    sources: top.map((h) => ({ type: h.type, title: h.title, article: h.article, date: h.date })),
  };
}

// 과부하(503)·레이트리밋(429) 대비: 재시도 + 모델 자동 폴백
// (구글이 폐기한 gemini-1.5는 제외 — 현행 2.x 계열만 사용)
const GEMINI_MODELS = Array.from(
  new Set([
    process.env.GEMINI_MODEL || "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
  ])
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generateGemini(messages: Msg[], system: string): Promise<string> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content) }],
  }));

  let lastErr: any = null;
  for (const modelName of GEMINI_MODELS) {
    const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: system });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await model.generateContent({ contents });
        return res.response.text();
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        const transient = /50[239]|429|high demand|overload|unavailable|rate limit/i.test(msg);
        if (transient && attempt === 0) {
          await sleep(1500); // 같은 모델 1회 재시도
          continue;
        }
        break; // 다음 모델로 폴백
      }
    }
  }
  throw lastErr;
}

// ── 무료 폴백 LLM (OpenAI 호환 엔드포인트 공용 호출기) ──
// Gemini 과부하/실패 시 사용. 같은 인터페이스로 Groq·OpenRouter 등을 붙인다.
async function generateOAICompat(
  cfg: { url: string; key: string; models: string[]; headers?: Record<string, string>; label: string },
  messages: Msg[],
  system: string
): Promise<string> {
  if (!cfg.key) throw new Error(`no key for ${cfg.label}`);
  const chat = [
    { role: "system", content: system },
    ...messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content) })),
  ];
  let lastErr: any = null;
  for (const model of cfg.models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}`, ...(cfg.headers || {}) },
          body: JSON.stringify({ model, messages: chat, temperature: 0 }),
        });
        if (!res.ok) {
          const t = await res.text();
          lastErr = new Error(`${cfg.label} ${res.status} ${t.slice(0, 200)}`);
          const transient = /50[239]|429|overload|rate limit|unavailable/i.test(`${res.status} ${t}`);
          if (transient && attempt === 0) {
            await sleep(1500);
            continue;
          }
          break; // 다음 모델
        }
        const j: any = await res.json();
        const text = j?.choices?.[0]?.message?.content || "";
        if (text) return text;
        lastErr = new Error(`${cfg.label} empty response`);
        break;
      } catch (e: any) {
        lastErr = e;
        if (attempt === 0) {
          await sleep(1500);
          continue;
        }
        break;
      }
    }
  }
  throw lastErr;
}

// Groq(무료) — llama 계열. 빠르지만 한국어 법령 추론은 약한 편.
const groqKey = () => process.env.GROQ_API_KEY || "";
const GROQ_MODELS = Array.from(
  new Set([process.env.GROQ_MODEL || "llama-3.3-70b-versatile", "llama-3.1-8b-instant"])
);
const generateGroq = (messages: Msg[], system: string) =>
  generateOAICompat(
    { url: "https://api.groq.com/openai/v1/chat/completions", key: groqKey(), models: GROQ_MODELS, label: "groq" },
    messages,
    system
  );

// OpenRouter(무료) — DeepSeek V3 / Qwen 등 강한 모델을 무료로. 한국어 추론이 llama보다 나음.
const orKey = () => process.env.OPENROUTER_API_KEY || "";
const OR_MODELS = Array.from(
  new Set([
    process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat-v3-0324:free",
    "qwen/qwen-2.5-72b-instruct:free",
    "meta-llama/llama-3.3-70b-instruct:free",
  ])
);
const generateOpenRouter = (messages: Msg[], system: string) =>
  generateOAICompat(
    {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: orKey(),
      models: OR_MODELS,
      headers: { "X-Title": "sobang-law-ai" },
      label: "openrouter",
    },
    messages,
    system
  );

// 동적 근거 선택: 질문 난이도에 따라 건수가 변동(점수 임계 + 하한/상한 + 계층 커버리지).
//  환경변수로 조정: RAG_MIN(기본 8) · RAG_MAX(기본 24) · RAG_RATIO(기본 0.5)
const isInterp = (t: string) => t === "질의회신" || t === "법령해석";

async function retrieveForRead(query: string): Promise<{ served: Hit[]; context: string }> {
  const MIN = Math.max(1, parseInt(process.env.RAG_MIN || "8", 10) || 8);
  const MAX = Math.max(MIN, parseInt(process.env.RAG_MAX || "24", 10) || 24);
  const RATIO = Math.min(0.95, Math.max(0.05, parseFloat(process.env.RAG_RATIO || "0.5") || 0.5));
  const MAX_INTERP = Math.max(0, parseInt(process.env.RAG_MAX_INTERP || "3", 10));
  // 질문이 사례·해석을 직접 묻는 경우엔 질의회신을 더 허용
  const wantsInterp = /질의|회신|사례|해석|판례|유권|선례|이런 경우|적용.*되나|봐도\s*되/.test(query);

  const exact: Hit[] = [];
  for (const r of refsFrom(query)) exact.push(...lookupExact("", r));
  const pool = await search(query, 40);

  const byId = new Map<string, Hit>();
  for (const h of [...exact, ...pool]) if (!byId.has(h.id)) byId.set(h.id, h);
  const all = [...byId.values()].sort((a, b) => b.score - a.score);
  if (all.length === 0) return { served: [], context: "" };

  const exactIds = new Set(exact.map((h) => h.id));
  const lawAll = all.filter((h) => !isInterp(h.type));
  const interpAll = all.filter((h) => isInterp(h.type));
  const lawTop = lawAll[0]?.score ?? all[0].score;

  const picked = new Map<string, Hit>();
  const add = (h: Hit) => {
    if (!picked.has(h.id) && picked.size < MAX) picked.set(h.id, h);
  };

  // 1) 명시 참조(제N조/별표 N)는 항상 포함
  for (const h of all) if (exactIds.has(h.id) && !isInterp(h.type)) add(h);
  // 2) 법령(법률·령·규칙·별표·고시) 우선 — 점수 임계
  for (const h of lawAll) if (h.score >= lawTop * RATIO) add(h);
  // 3) 법령 하한 보장
  for (const h of lawAll) {
    if (picked.size >= MIN) break;
    add(h);
  }
  // 4) 법령 계층 커버리지(질의회신 제외)
  const types = new Set([...picked.values()].map((h) => h.type));
  for (const h of lawAll) {
    if (picked.size >= MAX) break;
    if (!types.has(h.type)) {
      add(h);
      types.add(h.type);
    }
  }
  // 5) 질의회신은 "꼭 필요할 때만": 법령 최고점과 견줄 만큼 강하게 관련될 때, 소수만
  const cap = wantsInterp ? Math.max(MAX_INTERP, 6) : MAX_INTERP;
  const interpThresh = (wantsInterp ? 0.45 : 0.78) * lawTop;
  let ic = 0;
  for (const h of interpAll) {
    if (ic >= cap || picked.size >= MAX) break;
    if (h.score >= interpThresh) {
      add(h);
      ic++;
    }
  }

  const served = [...picked.values()];
  return { served, context: formatContext(served) };
}

// 질의 재구성(HyDE-lite): 시민 말투 → 정식 법령용어 키워드로 변환해 검색어를 보강.
// 예) "교체 때문에 점검 못 함" → "자체점검 면제 또는 연기, 점검 연기 신청".
// 사례형 질문에서 정답 조문이 단어 불일치로 누락되는 것을 줄인다. 실패 시 원문만 사용.
async function expandQuery(q: string): Promise<string> {
  const sys =
    "당신은 대한민국 소방 법령 검색 보조기입니다. 사용자의 민원 질문을 읽고, 답의 근거가 될 법령을 찾기 위한 '정식 법령용어·제도명·예상 조문 키워드'만 쉼표로 5~12개 출력하세요. 시민이 쓴 일상어를 법령용어로 바꾸세요(예: '점검 못 함'→'자체점검 면제 또는 연기', '비상구 막음'→'피난시설 폐쇄'). 설명·문장 금지, 키워드만 한 줄로.";
  const msg: Msg[] = [{ role: "user", content: q }];
  let out = "";
  if (process.env.GEMINI_API_KEY) {
    try {
      out = await generateGemini(msg, sys);
    } catch {
      /* 무시 — Groq로 */
    }
  }
  if (!out && groqKey()) {
    try {
      out = await generateGroq(msg, sys);
    } catch {
      /* 무시 — 원문만 사용 */
    }
  }
  return (out || "").replace(/^[^:]*:/, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

// ── 에이전틱 보강 라운드(무료 경로용, 함수호출 API 불필요한 텍스트 프로토콜) ──
// 모델이 확보된 자료를 보고 "추가로 필요한 근거"를 LOOKUP/SEARCH 줄로 요청하면 실행해 합친다.
// 예) 화재예방법 별표 4(등급 정의)가 「소방시설법 시행령」 별표 4(자탐 기준)를 참조하는 2단 추론 보강.
const PLANNER_PROMPT = `당신은 대한민국 소방 법령 리서치 플래너입니다.
[질문]에 정확히 답하려면 [확보된 자료]만으로 충분한지 판단하세요.
특히 자료 본문이 「○○법 시행령」 별표 N, 법 제N조 같은 다른 조문·별표를 참조하는데 그 원문이 [확보된 자료]에 없다면, 그 원문을 반드시 요청하세요(기준 수치는 참조 원문에 있습니다).
추가 자료가 필요하면 아래 형식의 줄만 출력하세요(설명 금지, 합계 4줄 이하):
LOOKUP: 법령명|제N조
LOOKUP: 법령명|별표 N
SEARCH: 정식 법령용어 검색어
더 필요한 자료가 없으면 READY 한 단어만 출력하세요.`;

async function agentAugment(lastUser: string, served: Hit[]): Promise<void> {
  const ROUNDS = Math.max(0, parseInt(process.env.AGENT_ROUNDS || "2", 10));
  const CAP = 30; // 컨텍스트 폭주 방지 상한
  const ids = new Set(served.map((h) => h.id));
  for (let round = 0; round < ROUNDS && served.length < CAP; round++) {
    // 플래너에게는 압축 자료만(판단용) — 토큰 절약 + Groq 413 방지
    const planCtx = formatContext(served.slice(0, 16), 350);
    const planMsg: Msg[] = [{ role: "user", content: `[질문]\n${lastUser}\n\n[확보된 자료]\n${planCtx}` }];
    let plan = "";
    if (process.env.GEMINI_API_KEY) {
      try {
        plan = await generateGemini(planMsg, PLANNER_PROMPT);
      } catch {
        /* Groq로 */
      }
    }
    if (!plan && groqKey()) {
      try {
        plan = await generateGroq(planMsg, PLANNER_PROMPT);
      } catch {
        return; // 플래너 불가 — 보강 없이 진행
      }
    }
    if (!plan || /^\s*READY\b/m.test(plan)) return;

    const lookups = [...plan.matchAll(/^\s*LOOKUP:\s*(.+)$/gim)].map((m) => m[1].trim()).slice(0, 3);
    const searches = [...plan.matchAll(/^\s*SEARCH:\s*(.+)$/gim)].map((m) => m[1].trim()).slice(0, 3);
    if (lookups.length === 0 && searches.length === 0) return;

    let added = 0;
    for (const l of lookups) {
      const [name, art] = l.includes("|") ? l.split("|").map((s) => s.trim()) : ["", l.trim()];
      for (const h of lookupExact(name, art)) {
        if (!ids.has(h.id) && served.length < CAP) {
          ids.add(h.id);
          served.push(h);
          added++;
        }
      }
    }
    for (const q of searches) {
      for (const h of await search(q, 5)) {
        if (!ids.has(h.id) && served.length < CAP) {
          ids.add(h.id);
          served.push(h);
          added++;
        }
      }
    }
    if (added === 0) return; // 더 못 찾으면 종료(무한루프 방지)
  }
}

async function answerGemini(incoming: Msg[], lastUser: string) {
  // 명시 참조(제N조/별표 N)가 없는 "사례·개념형" 질문에만 질의 재구성 적용
  let retrievalQuery = lastUser;
  if (refsFrom(lastUser).length === 0) {
    const expansion = await expandQuery(lastUser);
    if (expansion) retrievalQuery = `${lastUser} ${expansion}`;
  }
  const { served: initialServed } = await retrieveForRead(retrievalQuery);
  const served: Hit[] = [...initialServed];
  if (served.length === 0) {
    return { answer: "검색된 자료에 없습니다. (제공된 법령 데이터에서 관련 조문을 찾지 못했습니다.)", sources: [], mode: "llm" };
  }

  // 에이전틱 보강: 자료 간 참조 사슬(등급 정의→설치 기준 등)을 모델이 직접 따라가게 함
  const initialCount = served.length;
  try {
    await agentAugment(lastUser, served);
  } catch {
    /* 보강 실패해도 초기 자료로 진행 */
  }
  const agentAdded = served.slice(initialCount); // 모델이 "꼭 필요하다"고 요청해 가져온 자료

  const context = formatContext(served);
  const system = `${SYSTEM_PROMPT}

────────── [검색자료] (아래 자료만 근거로 사용. 여기에 없는 내용은 "검색된 자료에 없습니다"라고 답하세요) ──────────

${context}`;

  // 무료 폴백 모델은 토큰 한도가 작아 컨텍스트를 압축해서 보냄(413 Request too large 방지)
  // 중요: 에이전트 보강 자료가 목록 끝에 붙으므로, 단순 slice하면 정작 핵심 근거가 잘림 → 보강분 우선 포함
  const FB_MAX_CHUNKS = Math.max(1, parseInt(process.env.GROQ_MAX_CHUNKS || "8", 10) || 8);
  const FB_MAX_PER_CHUNK = Math.max(200, parseInt(process.env.GROQ_MAX_PER_CHUNK || "700", 10) || 700);
  const compactPick = [...agentAdded, ...served.slice(0, initialCount)].slice(0, FB_MAX_CHUNKS);
  const compactContext = formatContext(compactPick, FB_MAX_PER_CHUNK);
  const compactSystem = `${SYSTEM_PROMPT}

────────── [검색자료] (아래 자료만 근거로 사용. 없는 내용은 "검색된 자료에 없습니다") ──────────

${compactContext}`;

  // 폴백 사다리: Gemini(전체) → OpenRouter(DeepSeek/Qwen, 압축) → Groq(llama, 압축) → 검색전용
  // OpenRouter를 Groq보다 먼저 두는 이유: 무료라도 한국어 법령 추론이 더 낫기 때문.
  const fallbacks: { name: string; label: string; gen: (m: Msg[], s: string) => Promise<string> }[] = [];
  if (orKey()) fallbacks.push({ name: "openrouter", label: "OpenRouter(DeepSeek/Qwen)", gen: generateOpenRouter });
  // DISABLE_GROQ=1 이면 Groq를 폴백에서 제외(품질 문제 시 끄기용)
  if (groqKey() && process.env.DISABLE_GROQ !== "1")
    fallbacks.push({ name: "groq", label: "Groq(llama)", gen: generateGroq });

  let draft = "";
  let usedFallback: { name: string; label: string; gen: (m: Msg[], s: string) => Promise<string> } | null = null;
  const errs: string[] = [];
  if (process.env.GEMINI_API_KEY) {
    try {
      draft = await generateGemini(incoming, system);
    } catch (e: any) {
      errs.push("gemini: " + String(e?.message || e).slice(0, 140));
    }
  }
  for (const fb of fallbacks) {
    if (draft) break;
    try {
      draft = await fb.gen(incoming, compactSystem);
      usedFallback = fb;
    } catch (e: any) {
      errs.push(`${fb.name}: ` + String(e?.message || e).slice(0, 140));
    }
  }
  if (!draft) {
    const reason = errs.join(" | ") || "LLM 미설정";
    console.error("[chat] LLM failed:", reason);
    const fb = await buildSearchOnly(lastUser);
    fb.answer =
      `⚠️ LLM 일시 오류로 정리된 답변을 만들지 못했습니다.\n(진단 원인: ${reason})\n아래는 검색된 근거 원문입니다.\n\n` +
      fb.answer;
    return fb;
  }

  // 검증 패스: 초안을 원본과 대조해 인용·수치 불일치 정정.
  //  Gemini 경로 = 전체 원본 / 폴백 경로 = 압축 원본(413 방지) — 환각(수치 창작) 방어라 생략하지 않음
  let finalAnswer = draft;
  try {
    const verifySources = usedFallback ? compactPick : served;
    const cap = usedFallback ? FB_MAX_PER_CHUNK : 0;
    const sourcesText = verifySources
      .map((s, i) => {
        const body = cap > 0 && s.text.length > cap ? s.text.slice(0, cap) + " …(이하 생략)" : s.text;
        return `[원본자료 ${i + 1}] ${s.type} | ${s.title} | ${s.article || ""} | ${s.date}\n${body}`;
      })
      .join("\n──────────\n");
    const verifyMsg: Msg[] = [
      { role: "user", content: `[원본 자료]\n${sourcesText}\n\n────────────────\n[검증 대상 답변]\n${draft}` },
    ];
    const verified = usedFallback ? await usedFallback.gen(verifyMsg, VERIFY_PROMPT) : await generateGemini(verifyMsg, VERIFY_PROMPT);
    if (verified) finalAnswer = verified;
  } catch {
    /* 검증 실패 시 초안 유지 */
  }

  const warnings: string[] = [];
  const bad = verifyQuotes(finalAnswer, served);
  if (bad.length) warnings.push(`⛔ 인용 검증 실패(원본과 불일치 — 신뢰 불가): ${bad.map((q) => "«" + q + "»").join(" / ")}`);
  const gaps = citationGaps(finalAnswer, served);
  if (gaps.length) warnings.push(`⚠️ 참조 검증: ${gaps.join(", ")} 에 해당하는 검색자료를 찾지 못했습니다. 원문을 직접 확인하세요.`);
  if (warnings.length) finalAnswer += `\n\n──────────\n${warnings.join("\n")}`;

  // 생성 모델 표기(품질 추적용): 폴백 답변은 정확도가 낮을 수 있음을 명시 + 앞서 실패한 공급자 진단
  if (usedFallback) {
    const tried = errs.length ? `\n  (앞서 실패: ${errs.join(" / ")})` : "";
    finalAnswer += `\n\n─ 생성: ${usedFallback.label}(보조 모델, Gemini 일시 불가로 대체 — 중요 사안은 재질문 권장)${tried}`;
  }

  return {
    answer: finalAnswer,
    sources: served.map((h) => ({ type: h.type, title: h.title, article: h.article, date: h.date })),
    mode: usedFallback ? `llm-${usedFallback.name}` : "llm-gemini",
  };
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const incoming: Msg[] = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...incoming].reverse().find((m) => m.role === "user")?.content?.toString().trim() || "";
  if (!lastUser) return NextResponse.json({ error: "질문이 비어 있습니다." }, { status: 400 });

  if (indexSize() === 0) {
    return NextResponse.json({
      answer:
        "검색 인덱스가 비어 있습니다. ./data 폴더에 법령 파일을 넣고 `npm run ingest`를 실행한 뒤 다시 배포해 주세요.",
      sources: [],
    });
  }

  // 공급자 자동 선택: LLM_PROVIDER 우선 → Gemini/OpenRouter/Groq 키 → Anthropic 키 → 없으면 검색전용
  const hasFreeLLM = !!(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GROQ_API_KEY);
  const provider = (
    process.env.LLM_PROVIDER ||
    (process.env.LLM_MODE === "search"
      ? "search"
      : hasFreeLLM
      ? "llm"
      : process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : "search")
  ).toLowerCase();

  if (provider === "search") return NextResponse.json(await buildSearchOnly(lastUser));
  // "llm" = Gemini 우선, 실패 시 Groq(무료) 폴백 (구버전 호환: "gemini"/"groq"도 동일 경로)
  if (provider === "llm" || provider === "gemini" || provider === "groq")
    return NextResponse.json(await answerGemini(incoming, lastUser));
  // provider === "anthropic" → 아래 에이전틱 파이프라인 진행

  const anthropic = new Anthropic();
  const agentSystem = `${SYSTEM_PROMPT}\n\n${AGENT_INSTRUCTION}`;

  // 대화 이력을 단순 텍스트 메시지로 정규화(과거 도구 블록은 보내지 않음)
  const messages: Msg[] = incoming.map((m) => ({ role: m.role, content: m.content.toString() }));

  const served: Hit[] = [];
  const servedIds = new Set<string>();
  let draft = "";

  try {
    // ── 1) 에이전틱 다단계 검색 루프 ──────────────────────────────
    for (let round = 0; round < MAX_SEARCH_ROUNDS; round++) {
      const resp: any = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: agentSystem,
        tools: TOOLS as any,
        // 첫 호출은 반드시 도구(검색/조회)를 쓰도록 강제, 이후엔 모델 자율
        tool_choice: round === 0 ? ({ type: "any" } as any) : ({ type: "auto" } as any),
        output_config: { effort: "max" } as any,
        messages,
      });

      if (resp.stop_reason === "refusal") {
        return NextResponse.json({
          answer: "요청을 처리할 수 없습니다(안전 정책). 질문을 바꿔 다시 시도해 주세요.",
          sources: [],
        });
      }

      // 어시스턴트 응답(사고·도구 블록 포함)을 그대로 이력에 추가 (동일 모델 재전송 규칙 준수)
      messages.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter((b: any) => b.type === "tool_use");
      if (toolUses.length === 0) {
        draft = textOf(resp.content);
        break;
      }

      const toolResults: any[] = [];
      for (const tu of toolUses) {
        let hits: Hit[] = [];
        if (tu.name === "lookup_article") {
          hits = lookupExact((tu.input?.law_name ?? "").toString(), (tu.input?.article ?? "").toString());
        } else {
          hits = await search((tu.input?.query ?? "").toString(), PER_SEARCH_TOPK);
        }
        for (const h of hits) {
          if (!servedIds.has(h.id)) {
            servedIds.add(h.id);
            served.push(h);
          }
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: hits.length ? formatContext(hits) : "결과 없음. 다른 도구/검색어로 시도하세요.",
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    // 루프가 끝까지 갔는데 답이 없으면 도구 없이 최종 답변 강제
    if (!draft) {
      const finalResp: any = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: agentSystem,
        tools: TOOLS as any,
        tool_choice: { type: "none" } as any,
        output_config: { effort: "max" } as any,
        messages,
      });
      draft = textOf(finalResp.content) || "검색된 자료로는 답변을 구성하지 못했습니다.";
    }

    // ── 2) 검증 패스: 초안을 원본 자료와 한 글자씩 대조 ─────────────
    let finalAnswer = draft;
    if (served.length > 0) {
      const sourcesText = served
        .map(
          (s, i) =>
            `[원본자료 ${i + 1}] 유형:${s.type} | 명칭:${s.title} | ${s.article || ""} | 시행일/회신일자:${s.date}\n${s.text}`
        )
        .join("\n──────────\n");

      const verifyResp: any = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8000,
        system: VERIFY_PROMPT,
        output_config: { effort: "max" } as any,
        messages: [
          {
            role: "user",
            content: `[원본 자료]\n${sourcesText}\n\n────────────────\n[검증 대상 답변]\n${draft}`,
          },
        ],
      });
      if (verifyResp.stop_reason !== "refusal") {
        finalAnswer = textOf(verifyResp.content) || draft;
      }
    }

    // ── 3) 기계적 검증: 인용 verbatim 대조 + 조/별표 참조 실재 확인 ──
    const warnings: string[] = [];

    const badQuotes = verifyQuotes(finalAnswer, served);
    if (badQuotes.length > 0) {
      warnings.push(
        `⛔ 인용 검증 실패: 다음 «원문 인용»이 검색자료에서 글자 단위로 확인되지 않았습니다(신뢰 불가 — 반드시 원문 직접 확인): ${badQuotes
          .map((q) => `«${q}»`)
          .join(" / ")}`
      );
    }

    const gaps = citationGaps(finalAnswer, served);
    if (gaps.length > 0) {
      warnings.push(
        `⚠️ 참조 검증: 답변이 언급한 ${gaps.join(", ")} 에 해당하는 검색자료를 찾지 못했습니다. 해당 부분은 원문을 직접 확인하세요.`
      );
    }

    if (warnings.length > 0) {
      finalAnswer += `\n\n──────────\n${warnings.join("\n")}`;
    }

    return NextResponse.json({
      answer: finalAnswer,
      sources: served.map((h) => ({
        type: h.type,
        title: h.title,
        article: h.article,
        date: h.date,
      })),
    });
  } catch (e: any) {
    console.error("[chat] error:", e);
    return NextResponse.json(
      { error: "답변 생성 중 오류가 발생했습니다: " + (e?.message || "unknown") },
      { status: 500 }
    );
  }
}
