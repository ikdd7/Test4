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
  const norm = (s: string) => s.replace(/\s+/g, "");
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
  const exact: Hit[] = [];
  for (const r of refsFrom(query)) exact.push(...lookupExact("", r));
  const hits = await search(query, 8);
  const seen = new Set<string>();
  const merged: Hit[] = [];
  for (const h of [...exact, ...hits]) {
    if (!seen.has(h.id)) {
      seen.add(h.id);
      merged.push(h);
    }
  }
  const top = merged.slice(0, 5); // 너무 길지 않게 상위 5건
  const isLaw = (t: string) => ["법률", "시행령", "시행규칙", "별표", "고시"].includes(t);
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
const GEMINI_MODELS = Array.from(
  new Set([
    process.env.GEMINI_MODEL || "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-1.5-flash",
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

async function retrieveForRead(query: string): Promise<{ served: Hit[]; context: string }> {
  const exact: Hit[] = [];
  for (const r of refsFrom(query)) exact.push(...lookupExact("", r));
  const hits = await search(query, 14);
  const seen = new Set<string>();
  const served: Hit[] = [];
  for (const h of [...exact, ...hits]) {
    if (!seen.has(h.id)) {
      seen.add(h.id);
      served.push(h);
    }
  }
  const top = served.slice(0, 16);
  return { served: top, context: formatContext(top) };
}

async function answerGemini(incoming: Msg[], lastUser: string) {
  const { served, context } = await retrieveForRead(lastUser);
  if (served.length === 0) {
    return { answer: "검색된 자료에 없습니다. (제공된 법령 데이터에서 관련 조문을 찾지 못했습니다.)", sources: [], mode: "gemini" };
  }
  const system = `${SYSTEM_PROMPT}

────────── [검색자료] (아래 자료만 근거로 사용. 여기에 없는 내용은 "검색된 자료에 없습니다"라고 답하세요) ──────────

${context}`;

  let draft: string;
  try {
    draft = await generateGemini(incoming, system);
  } catch (e: any) {
    // 모든 모델 과부하/실패 → 검색 결과(원문)라도 표시(우아한 강등)
    const fb = await buildSearchOnly(lastUser);
    fb.answer =
      "⚠️ LLM(제미나이) 일시 오류로 정리된 답변을 만들지 못했습니다(과부하일 수 있음 — 잠시 후 다시 시도). 아래는 검색된 근거 원문입니다.\n\n" +
      fb.answer;
    return fb;
  }

  let finalAnswer = draft;
  try {
    const sourcesText = served
      .map((s, i) => `[원본자료 ${i + 1}] ${s.type} | ${s.title} | ${s.article || ""} | ${s.date}\n${s.text}`)
      .join("\n──────────\n");
    const verified = await generateGemini(
      [{ role: "user", content: `[원본 자료]\n${sourcesText}\n\n────────────────\n[검증 대상 답변]\n${draft}` }],
      VERIFY_PROMPT
    );
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

  return {
    answer: finalAnswer,
    sources: served.map((h) => ({ type: h.type, title: h.title, article: h.article, date: h.date })),
    mode: "gemini",
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

  // 공급자 자동 선택: LLM_PROVIDER 우선 → Gemini 키 → Anthropic 키 → 없으면 검색전용
  const provider = (
    process.env.LLM_PROVIDER ||
    (process.env.LLM_MODE === "search"
      ? "search"
      : process.env.GEMINI_API_KEY
      ? "gemini"
      : process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : "search")
  ).toLowerCase();

  if (provider === "search") return NextResponse.json(await buildSearchOnly(lastUser));
  if (provider === "gemini") return NextResponse.json(await answerGemini(incoming, lastUser));
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
