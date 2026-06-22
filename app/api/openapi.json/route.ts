// ChatGPT GPTs "Actions"가 가져갈 OpenAPI 3.1 스키마. servers.url은 요청 호스트에서 자동 설정.
//  GPT 빌더 → Actions → "Import from URL"에 https://<도메인>/api/openapi.json 입력.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const origin = `${u.protocol}//${u.host}`;
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "소방법령 RAG 검색 (ask119)",
      description:
        "대한민국 소방 법령(소방시설법·화재예방법 + 시행령·시행규칙·별표·고시(NFTC)·질의회신)에서 근거 조문 원문을 검색한다. 설비 설치대상·기준, 소방안전관리자 선임, 자체점검, 과태료 등 질문에 사용.",
      version: "1.0.0",
    },
    servers: [{ url: origin }],
    paths: {
      "/api/search": {
        get: {
          operationId: "searchFireLaw",
          summary: "소방 법령 의미검색 / 정확조회",
          description:
            "query로 개념·조건 의미검색(리랭킹·면제별표 자동포함)하거나, law_name+article로 특정 조문/별표를 정확 조회한다. 본문에 '별표 N'·'제N조' 참조가 보이면 그 번호로 다시 호출해 끝까지 따라갈 것.",
          parameters: [
            {
              name: "query",
              in: "query",
              required: false,
              description: "검색어. 정식 법령용어 권장(예: '창고 자동화재탐지설비 설치대상', '3급 소방안전관리자 선임').",
              schema: { type: "string" },
            },
            {
              name: "law_name",
              in: "query",
              required: false,
              description: "정확조회용 법령명(예: 소방시설 설치 및 관리에 관한 법률 시행령). article과 함께 사용.",
              schema: { type: "string" },
            },
            {
              name: "article",
              in: "query",
              required: false,
              description: "정확조회용 조/별표 번호(예: 제13조, 별표 5). 있으면 의미검색보다 우선.",
              schema: { type: "string" },
            },
            {
              name: "topK",
              in: "query",
              required: false,
              description: "반환 개수(기본 12, 최대 24).",
              schema: { type: "integer", default: 12, minimum: 1, maximum: 24 },
            },
          ],
          responses: {
            "200": {
              description: "검색 결과",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      guide: { type: "string", description: "답변 작성 규칙(효력위계·경계사안 단정금지 등)." },
                      count: { type: "integer" },
                      context: { type: "string", description: "효력위계 순으로 정리된 근거 원문(그대로 인용 가능)." },
                      results: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            type: { type: "string", description: "자료유형(법률/시행령/시행규칙/별표/고시/질의회신)" },
                            title: { type: "string" },
                            article: { type: "string", nullable: true },
                            date: { type: "string" },
                            text: { type: "string", description: "조문 원문(수정 없이 인용할 것)" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  return NextResponse.json(spec);
}
