// ChatGPT GPTs "Actions"용 REST 엔드포인트(MCP가 아니라 일반 HTTP+OpenAPI).
// 검색만 담당하고 추론은 GPT(호스트 모델)가 직접 → 외부 LLM API 비용 0.
//  GET  /api/search?query=...&topK=12
//  GET  /api/search?law_name=...&article=별표 5   (정확 조회)
import { NextResponse } from "next/server";
import { lookupExact, formatContext } from "@/lib/search";
import { searchRanked } from "@/lib/retrieve";
import type { Hit } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GPT가 검색 결과로 답을 만들 때 따를 규칙(응답에 동봉 — GPT instructions가 비어도 동작).
const GUIDE = `[답변 규칙] 아래 results의 원문(text)만 근거로 답하라.
① 효력위계: 법령(법률·시행령·시행규칙·별표·고시=구속력) > 질의회신(공식 해석, 개정 가능).
② 수치 경계(이상/초과/미만/이하)는 원문 그대로, 임의 변경 금지.
③ 판정은 다단계로: 분류 정의 → 그 정의가 가리키는 다른 별표의 수치 기준 → 조건 대입 → 면제·대체(설치 면제 기준 별표 5) 확인.
④ 면적·용도 변경이면 변경 전·후를 각각 판정해 의무의 생김/없어짐 전환을 명시.
⑤ 근거가 충돌하거나 결론이 사용자가 안 준 사실(설치설비·용도·경과규정)에 좌우되면 단정하지 말고 "잠정 결론(경계 사안 — 관할 소방서 확인) + 양방향"으로.
⑥ results에 없으면 "검색된 자료에 없습니다"라고 답하고 지어내지 말 것.
※ 법령 정보 안내이며 법률 자문이 아님.`;

// 선택적 토큰: API_TOKEN 설정 시 Authorization: Bearer 또는 ?key= 로 일치해야 통과.
function authFail(req: Request): boolean {
  const need = process.env.API_TOKEN;
  if (!need) return false;
  const u = new URL(req.url);
  const tok = u.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return tok !== need;
}

function toResult(h: Hit) {
  return { type: h.type, title: h.title, article: h.article, date: h.date, text: h.text };
}

async function handle(req: Request, params: URLSearchParams) {
  if (authFail(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const query = (params.get("query") || "").trim();
  const lawName = (params.get("law_name") || "").trim();
  const article = (params.get("article") || "").trim();
  const topK = Math.min(24, Math.max(1, parseInt(params.get("topK") || "12", 10) || 12));

  let hits: Hit[] = [];
  if (article) {
    const raw = lookupExact(lawName, article); // 명시 참조(제N조/별표 N) 정확 조회
    if (lawName) {
      // 법령명이 주어져 단일 법으로 한정됐을 때만, 같은 번호의 stub(헤더만)·본문 중복을 본문(긴 것)으로 정리.
      const best = new Map<string, Hit>();
      for (const h of raw) {
        const key = (h.article || "").replace(/\s+/g, "");
        const cur = best.get(key);
        if (!cur || (h.text?.length || 0) > (cur.text?.length || 0)) best.set(key, h);
      }
      hits = [...best.values()];
    } else {
      hits = raw; // 법령명 미지정: 여러 법의 동일 번호가 섞일 수 있어 합치지 않음
    }
  } else if (query) {
    hits = await searchRanked(query, topK);
  } else {
    return NextResponse.json({ error: "query 또는 (law_name+article) 중 하나는 필수입니다." }, { status: 400 });
  }

  return NextResponse.json({
    guide: GUIDE,
    count: hits.length,
    context: hits.length ? formatContext(hits) : "검색된 자료에 없습니다.",
    results: hits.map(toResult),
  });
}

export async function GET(req: Request) {
  return handle(req, new URL(req.url).searchParams);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({} as any));
  const p = new URLSearchParams();
  for (const k of ["query", "law_name", "article", "topK", "key"]) {
    if (body?.[k] != null) p.set(k, String(body[k]));
  }
  return handle(req, p);
}
