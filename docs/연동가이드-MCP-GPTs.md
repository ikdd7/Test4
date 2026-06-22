# ask119 외부 연동 가이드 — claude.ai(MCP) · ChatGPT(GPTs)

ask119의 **검색(RAG)** 만 외부에 빌려주고, **답변 추론은 호스트 모델(Claude/GPT)** 이 직접 합니다.
→ 외부 LLM API 비용 0(구독 안에서 동작). 웹앱(`ask119.vercel.app`)은 그대로 Gemini를 씁니다.

| 경로 | 추론 모델 | 비용 | 엔드포인트 |
|---|---|---|---|
| 웹앱 `/` | Gemini 2.5-flash | 유료(토큰) | `/api/chat` |
| claude.ai 커넥터 | Claude(구독) | 0 | `/api/mcp` |
| ChatGPT GPTs | GPT(구독) | 0 | `/api/search` (+ `/api/openapi.json`) |

> `<도메인>` = `https://ask119.vercel.app` (커스텀 도메인 쓰면 그 주소).

---

## A. claude.ai 커스텀 커넥터 (MCP)

**필요 플랜:** Claude **Pro / Max / Team / Enterprise** (커스텀 커넥터 지원 플랜).

1. claude.ai 로그인 → 좌하단 프로필 → **Settings** → **Connectors**(또는 Feature/Connectors).
2. **Add custom connector** 클릭.
3. **Remote MCP server URL** 에 입력:
   - 토큰 안 쓸 때: `https://<도메인>/api/mcp`
   - 토큰 쓸 때(아래 D 참고): `https://<도메인>/api/mcp?key=<MCP_TOKEN>`
4. 저장 → 새 대화에서 **도구(검색)** 아이콘으로 `ask119` 켜기.
5. 질문하면 Claude가 `search_fire_law` / `lookup_article` 도구를 호출해 근거 원문을 받아 답합니다.

**제공 도구**
- `search_fire_law(query, topK?)` — 개념·조건 의미검색(리랭킹·면제별표 자동포함).
- `lookup_article(law_name?, article)` — `제13조`·`별표 5` 정확 조회.

---

## B. ChatGPT GPTs (Actions)

**필요 플랜:** ChatGPT **Plus / Team / Enterprise** (GPT 빌더 사용 가능 플랜).

1. ChatGPT → 좌측 **GPTs** → **+ Create**(또는 My GPTs → Create a GPT).
2. **Configure** 탭에서:
   - **Name:** `소방법령 도우미 (ask119)`
   - **Instructions:** 아래 C의 텍스트 붙여넣기.
3. **Actions** → **Create new action** → **Import from URL** 에 입력:
   `https://<도메인>/api/openapi.json`
   (스키마가 자동으로 로드되고 `searchFireLaw` 액션이 잡힙니다.)
4. (토큰 쓸 때) **Authentication** → **API Key** → Auth Type **Bearer** → 키에 `<API_TOKEN>` 입력.
5. 우측 미리보기에서 "700㎡ 창고 자체점검?" 등으로 테스트 → 저장/게시(Only me 권장).

> GPTs Actions는 MCP가 아니라 일반 HTTP를 씁니다. 그래서 GPT는 `/api/search`를, claude.ai는 `/api/mcp`를 사용합니다.

---

## C. GPT Instructions (붙여넣기용)

```
너는 대한민국 소방 법령(소방시설법·화재예방법 + 시행령·시행규칙·별표·고시(NFTC)·질의회신) 안내 도구다.
법률 자문가가 아니라 "근거 조문을 정확히 찾아 보여주는" 도구다. 모든 답은 한국어로.

[검색 규칙]
- 답하기 전에 반드시 searchFireLaw 액션으로 근거를 확보한다. 한 번으로 끝내지 말고 질문을 분해해 여러 번 호출한다.
- 명시 참조가 있으면(예 "별표 5", "제13조") law_name+article로 정확 조회한다.
- 결과 text에 "별표 N"·"제N조" 참조가 보이면 그 번호로 다시 호출해 사슬을 끝까지 따라간다.
- 실무용어는 법령용어로 바꿔 검색한다(예: 스프링쿨러→스프링클러설비, 완강기→피난기구).

[답변 규칙]
- 검색된 results의 원문(text)만 근거로 답한다. 없는 내용은 "검색된 자료에 없습니다"라고 하고 지어내지 않는다.
- 효력위계 구분: ① 법령(법률·시행령·시행규칙·별표·고시=구속력) ② 해석·참고(질의회신=공식 해석, 개정 가능, 연도 표시).
- 원문 인용은 «겹화살괄호» 안에 한 글자도 바꾸지 말고 넣는다. 수치 경계(이상/초과/미만/이하)는 원문 그대로.
- 판정 질문은 다단계로: 분류 정의 → 그 정의가 가리키는 다른 별표의 수치 기준 → 조건 대입 → 면제·대체(설치 면제 기준 별표 5: 예) 자동화재탐지설비로 비상경보설비 갈음) 확인.
- 면적·용도 변경(증축·축소·용도변경)이면 변경 전·후를 각각 판정해 "의무가 생김/없어짐(해지 가능)" 전환을 명시한다.

[경계·충돌 사안 — 확정 금지]
- 근거가 충돌하거나(법령 vs 질의회신), 결론이 사용자가 안 준 사실(실제 설치 설비·용도분류·공부상 면적·경과규정)에 좌우되거나, 경계값 부근이면 단정하지 말 것.
- 이때는 "잠정 결론(경계 사안 — 관할 소방서 확인 권장) + 양방향 해석(○○이면 A, △△이면 B) + 무엇을 확인해야 결론이 정해지는지"로 답한다.
- 솔직한 경계 표시가 틀린 단정보다 낫다. 확실하지 않으면 확실한 척하지 말 것.

[마무리] 답변 끝에 한 줄: "※ 본 도구는 법령 정보 안내이며 법률 자문이 아닙니다. 최종 판단은 원문 확인 및 관할 소방서·전문가 확인을 거치세요."
```

---

## D. Vercel 환경변수 (선택 — 외부 노출 보호)

토큰을 비워두면 누구나 검색 가능(법령 원문만 제공). 보호하려면 Vercel → Settings → Environment Variables 에 추가 후 Redeploy:

| 변수 | 용도 |
|---|---|
| `MCP_TOKEN` | claude.ai 커넥터 보호 — URL에 `?key=<값>` 붙임 |
| `API_TOKEN` | ChatGPT GPTs Action 보호 — GPT Authentication에 Bearer로 입력 |

> 50명 내부 공유면 토큰 하나씩 정해 공지하는 정도로 충분합니다.
