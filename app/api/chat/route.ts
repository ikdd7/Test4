import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { search, formatContext, indexSize } from "@/lib/search";
import { SYSTEM_PROMPT, AGENT_INSTRUCTION, VERIFY_PROMPT } from "@/lib/prompt";
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
    "소방 법령 데이터(법률/시행령/시행규칙/별표/고시/질의회신·법령해석)에서 관련 조문·표를 검색한다. 질문을 분해해 여러 번 호출하고, 본문에 나온 참조(별표 N, 법 제N조 등)도 추가로 검색해 근거 사슬을 끝까지 따라갈 것.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "검색어. 가능하면 정식 법령 용어로(예: '스프링클러설비 설치대상', '별표 4', '소방안전관리자 선임').",
      },
    },
    required: ["query"],
  },
};

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

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

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
        tools: [SEARCH_TOOL as any],
        // 첫 호출은 반드시 검색하도록 강제, 이후엔 모델 자율
        tool_choice: round === 0 ? ({ type: "tool", name: "search_law" } as any) : ({ type: "auto" } as any),
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
        const q = (tu.input?.query ?? "").toString();
        const hits = await search(q, PER_SEARCH_TOPK);
        for (const h of hits) {
          if (!servedIds.has(h.id)) {
            servedIds.add(h.id);
            served.push(h);
          }
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: hits.length ? formatContext(hits) : "검색결과 없음. 다른 검색어로 시도하세요.",
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
        tools: [SEARCH_TOOL as any],
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

    // ── 3) 프로그래밍 인용 검사: 언급한 조/별표가 자료에 실재하는지 ──
    const gaps = citationGaps(finalAnswer, served);
    if (gaps.length > 0) {
      finalAnswer += `\n\n⚠️ 자동검사: 답변이 언급한 ${gaps.join(", ")} 에 해당하는 검색자료를 찾지 못했습니다. 해당 부분은 반드시 원문을 직접 확인하세요.`;
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
