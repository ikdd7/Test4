// 소방 RAG 라우터 설정 — 신호어·후속동작을 한 곳에 모음(하드코딩 금지: 여기서만 수정).
// 판정1(규칙)에서 검색된 "법령 조각" 텍스트를 스캔하는 데 쓰임. (LLM 호출 없음)

// 위임 신호: 구체 기준을 하위 규범에 "명시적으로" 넘김 → 하위규정 확인 필요.
//  주의: "화재안전기준에 따라"는 별표에 너무 흔해 과확장되므로 제외(이런 미묘한 경우는 판정2가 처리).
export const DELEGATION_PATTERNS: string[] = [
  "대통령령으로\\s*정",
  "행정안전부령으로\\s*정",
  "총리령으로\\s*정",
  "고시로\\s*정",
  "소방청장이\\s*정하여\\s*고시",
];

// 참조 신호: 다른 별표/조문을 가리킴 → 그 원문을 정확조회로 추가
export const REFERENCE_PATTERNS: string[] = [
  "별표\\s*\\d+(?:의\\s*\\d+)?",
  "제\\s*\\d+\\s*조(?:의\\s*\\d+)?\\s*를?\\s*준용",
  "제\\s*\\d+\\s*조(?:의\\s*\\d+)?\\s*에?\\s*따라",
];

// 예외 신호: 단서·제외 → 포섭이 모호할 수 있음 → 판정2(LLM)로 넘김
export const EXCEPTION_PATTERNS: string[] = [
  "다만[^。.\\n]{0,80}그러하지\\s*아니하다",
  "(?:을|를)\\s*제외(?:한다|하고)",
  "특별한\\s*사유",
  "예외로\\s*한다",
];

// 라벨별 후속 동작(문서화용 — 실제 분기는 router가 구현)
export const LABEL_ACTIONS = {
  SUFFICIENT: "추가검색 없이 생성(질의회신 배제)",
  NEED_DELEGATION: "시행령·시행규칙·고시·별표 추가 조회 후 생성",
  NEED_INTERPRETATION: "질의회신(유권해석) 검색 후 생성(효력위계 명시)",
} as const;

// 하위규정(위임 대상) 자료유형
export const SUBORDINATE_TYPES = ["시행령", "시행규칙", "고시", "별표"];
// 법령(구속력) 자료유형
export const LAW_TYPES = ["법률", "시행령", "시행규칙", "별표", "고시"];

export function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "g"));
}
