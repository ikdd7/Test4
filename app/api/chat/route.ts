import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { search, formatContext, indexSize } from "@/lib/search";
import { SYSTEM_PROMPT } from "@/lib/prompt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fable 5는 적응형 사고가 항상 켜져 있어 어려운 질문에서 응답이 길어질 수 있음 → 타임아웃 여유.
// (Vercel이 플랜 한도에 맞게 자동으로 상한 적용)
export const maxDuration = 300;

// Claude Fable 5: thinking 항상 켜짐(파라미터 생략), prefill/temperature 미지원 — 본 코드는 모두 미사용.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-fable-5";

type Msg = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const messages: Msg[] = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content?.trim() || "";

  if (!lastUser) {
    return NextResponse.json({ error: "질문이 비어 있습니다." }, { status: 400 });
  }

  if (indexSize() === 0) {
    return NextResponse.json({
      answer:
        "검색 인덱스가 비어 있습니다. ./data 폴더에 법령 파일을 넣고 `npm run ingest`를 실행한 뒤 다시 배포해 주세요.",
      sources: [],
    });
  }

  // 1) 하이브리드 검색 (계층 가로지름)
  const hits = await search(lastUser, 12);
  const context = formatContext(hits);

  // 2) 시스템 프롬프트 + 검색자료(컨텍스트) 구성. 검색자료만 근거로 답하도록 명시.
  const system = `${SYSTEM_PROMPT}

────────── [검색자료] (아래 자료만 근거로 사용. 여기에 없는 내용은 "검색된 자료에 없습니다"라고 답하세요) ──────────

${context || "(관련 검색자료 없음)"}`;

  const anthropic = new Anthropic();

  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    if (resp.stop_reason === "refusal") {
      return NextResponse.json({
        answer: "요청을 처리할 수 없습니다(안전 정책). 질문을 바꿔 다시 시도해 주세요.",
        sources: [],
      });
    }

    const answer = resp.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");

    return NextResponse.json({
      answer,
      sources: hits.map((h) => ({
        type: h.type,
        title: h.title,
        article: h.article,
        date: h.date,
      })),
    });
  } catch (e: any) {
    console.error("[chat] anthropic error:", e);
    return NextResponse.json(
      { error: "답변 생성 중 오류가 발생했습니다: " + (e?.message || "unknown") },
      { status: 500 }
    );
  }
}
