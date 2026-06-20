import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { search, lookupExact, formatContext } from "@/lib/search";

// claude.ai 웹 "커스텀 커넥터"용 원격 MCP 서버(Streamable HTTP).
// 검색만 담당하고, 답변 추론은 클로드가 직접 → 외부 LLM API 비용 0.
export const runtime = "nodejs";
export const maxDuration = 60;

// 클로드가 검색 결과로 답을 만들 때 따를 규칙(도구 설명에 주입)
const GUIDE = `[답변 규칙] 아래 도구가 돌려주는 [검색자료] 원문만 근거로 답하라.
① 효력위계 구분: 법령(법률·시행령·시행규칙·별표·고시=구속력) > 질의회신(공식 해석, 개정 가능).
② 수치 경계(이상/초과/미만/이하)는 원문 표현 그대로, 임의 변경 금지.
③ 등급·대상 판정은 다단계로: 분류 정의 → 그 정의가 가리키는 다른 별표의 수치 기준 → 조건 대입 → 면제·대체(설치 면제 기준 별표 5: 예) 스프링클러로 자탐 면제) 확인.
④ 면적·용도 변경(증축·축소·용도변경)이면 변경 전·후를 각각 판정해 "선임/설치 의무가 생김/없어짐(해지 가능)" 전환을 명시.
⑤ 검색자료에 없으면 "검색된 자료에 없습니다"라고 답하고 지어내지 말 것.
※ 법령 정보 안내이며 법률 자문이 아님. 최종 판단은 원문·관할 소방서 확인.`;

const mcp = createMcpHandler(
  (server) => {
    server.tool(
      "search_fire_law",
      `대한민국 소방 법령(소방시설법·화재예방법 + 시행령·시행규칙·별표·고시(NFTC 화재안전기술기준)·질의회신)에서 개념·조건·키워드로 의미검색해 근거 조문 원문을 반환한다. 소방 설비 설치대상·기준, 소방안전관리자 선임, 과태료, 자체점검 등 질문에 사용.\n\n${GUIDE}`,
      {
        query: z
          .string()
          .describe("검색어. 가능하면 정식 법령용어로(예: '자동화재탐지설비 설치대상', '소방안전관리자 선임 대상', '창고 옥내소화전 설치기준')."),
        topK: z.number().int().min(1).max(24).optional().describe("반환 개수(기본 12)"),
      },
      async ({ query, topK }) => {
        const hits = await search(query, topK ?? 12);
        const text = hits.length ? formatContext(hits) : "검색된 자료에 없습니다.";
        return { content: [{ type: "text", text }] };
      }
    );

    server.tool(
      "lookup_article",
      "법령명+조번호 또는 별표번호로 1:1 정확 조회(의미검색보다 정확·확정적). '제13조', '별표 4' 같은 명시적 참조가 있으면 이 도구를 우선 사용.",
      {
        law_name: z
          .string()
          .optional()
          .describe("법령명(선택). 예: 소방시설 설치 및 관리에 관한 법률 시행령"),
        article: z.string().describe("조번호 또는 별표번호. 예: 제13조, 제24조, 별표 4"),
      },
      async ({ law_name, article }) => {
        const hits = lookupExact(law_name ?? "", article);
        const text = hits.length ? formatContext(hits) : "해당 조문을 검색자료에서 찾지 못했습니다.";
        return { content: [{ type: "text", text }] };
      }
    );
  },
  {},
  { basePath: "/api" }
);

// 선택적 토큰 보호: MCP_TOKEN 환경변수가 설정돼 있으면 ?key= 또는 Authorization: Bearer 로 일치해야 통과.
function auth(req: Request): Response | null {
  const need = process.env.MCP_TOKEN;
  if (!need) return null; // 미설정 시 공개(법령 원문만 제공)
  const u = new URL(req.url);
  const tok = u.searchParams.get("key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (tok === need) return null;
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export async function GET(req: Request) {
  return auth(req) ?? mcp(req);
}
export async function POST(req: Request) {
  return auth(req) ?? mcp(req);
}
export async function DELETE(req: Request) {
  return auth(req) ?? mcp(req);
}
