// 국가법령정보 공동활용(OpenAPI, law.go.kr) 클라이언트 — "대통령령으로 정한다 → 실제 조문" 같은
// 위임/참조의 권위 있는 원문을 메우는 용도. 로컬 인덱스에 없는 조문을 보충할 때만 호출한다.
//
// 사용 전제(사용자 작업 필요):
//  1) open.law.go.kr 에서 OPEN API 신청 → 기관코드(OC) 발급
//  2) Vercel 환경변수 LAW_API_OC=발급받은OC 설정
//  3) Vercel 네트워크 정책에서 www.law.go.kr 아웃바운드 허용
// 위 중 하나라도 없으면 fetch가 실패하므로, 이 모듈은 "항상 null로 안전 폴백"한다(기존 동작 불변).
import type { Hit } from "./types";

const OC = () => process.env.LAW_API_OC || "";
const BASE = "https://www.law.go.kr/DRF";
const TIMEOUT_MS = Math.max(2000, parseInt(process.env.LAW_API_TIMEOUT || "6000", 10) || 6000);

// 동일 (법령명·조) 재호출 비용/지연 방지용 메모리 캐시(함수 인스턴스 생명주기 내).
const cache = new Map<string, Hit | null>();

function jo6(article: string): string | null {
  const m = article.replace(/\s+/g, "").match(/제(\d+)조(?:의(\d+))?/);
  if (!m) return null;
  const jo = m[1].padStart(4, "0");
  const ga = (m[2] || "0").padStart(2, "0");
  return jo + ga;
}

async function getJSON(url: string): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      return null; // HTML 오류 페이지 등
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 법령명으로 법령 일련번호(MST) 조회. 실패 시 null.
async function findMST(lawName: string): Promise<string | null> {
  const oc = OC();
  if (!oc) return null;
  const u = `${BASE}/lawSearch.do?OC=${encodeURIComponent(oc)}&target=law&type=JSON&display=1&query=${encodeURIComponent(lawName)}`;
  const j = await getJSON(u);
  const list = j?.LawSearch?.law;
  const first = Array.isArray(list) ? list[0] : list;
  const mst = first?.법령일련번호 || first?.["법령일련번호"] || first?.MST;
  return mst ? String(mst) : null;
}

// 특정 조문 텍스트를 권위 원문에서 가져와 Hit 형태로 반환. 실패 시 null(폴백).
export async function fetchLawArticle(lawName: string, article: string): Promise<Hit | null> {
  const oc = OC();
  if (!oc || !lawName) return null;
  const key = `${lawName}::${article}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const target = jo6(article); // 별표는 별도 서비스라 본 함수는 조문(제N조)만 처리
  if (!target) {
    cache.set(key, null);
    return null;
  }
  const mst = await findMST(lawName);
  if (!mst) {
    cache.set(key, null);
    return null;
  }
  const u = `${BASE}/lawService.do?OC=${encodeURIComponent(oc)}&target=law&type=JSON&MST=${encodeURIComponent(mst)}&JO=${target}`;
  const j = await getJSON(u);
  // 응답 구조가 버전에 따라 다를 수 있어 방어적으로 탐색.
  const lawRoot = j?.법령 || j?.Law || j;
  let units = lawRoot?.조문?.조문단위 || lawRoot?.조문 || [];
  if (!Array.isArray(units)) units = units ? [units] : [];
  const wantNo = article.replace(/\s+/g, "");
  const unit =
    units.find((x: any) => String(x?.조문번호 || "").replace(/\s+/g, "").includes(wantNo.replace(/제|조/g, ""))) ||
    units[0];
  const content =
    unit?.조문내용 ||
    (Array.isArray(unit?.항) ? unit.항.map((h: any) => h?.항내용).filter(Boolean).join("\n") : "") ||
    "";
  const text = String(content).trim();
  if (!text) {
    cache.set(key, null);
    return null;
  }
  const hit: Hit = {
    id: `lawapi:${lawName}:${wantNo}`,
    type: lawName.includes("시행규칙") ? "시행규칙" : lawName.includes("시행령") ? "시행령" : "법률",
    title: lawName,
    article: wantNo,
    date: String(lawRoot?.기본정보?.시행일자 || lawRoot?.시행일자 || "법령정보센터"),
    parent: null,
    source_file: "law.go.kr/OpenAPI",
    text,
    embedding: null,
    role: "parent",
    parent_id: null,
    score: 0,
  };
  cache.set(key, hit);
  return hit;
}

export const lawApiEnabled = () => !!OC();
