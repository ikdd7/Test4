// 공용 검색 파이프라인 — MCP(/api/mcp)와 GPTs Action(/api/search)이 같은 코드를 공유.
// 검색 + 리랭킹 + 참조엣지 확장 + 허브 강제포함 (웹 /api/chat 의 retrieveForRead와 동일 빌딩블록).
import { search, queryTerms } from "./search";
import { rerank } from "./rerank";
import { expandReferences, forceIncludeHubs } from "./refgraph";
import type { Hit } from "./types";

const isInterp = (t: string) => t === "질의회신" || t === "법령해석";

export async function searchRanked(query: string, k = 12): Promise<Hit[]> {
  const pool = await search(query, Math.max(k, 50)); // 1차: 재현율 위주로 넉넉히
  const refAdded = expandReferences(pool.filter((h) => !isInterp(h.type)).slice(0, 8));
  const hubs = forceIncludeHubs(query);
  const byId = new Map<string, Hit>();
  for (const h of [...pool, ...refAdded, ...hubs]) if (!byId.has(h.id)) byId.set(h.id, h);
  const ranked = rerank([...byId.values()], queryTerms(query));
  const hubIds = new Set(hubs.map((h) => h.id)); // 허브는 항상 앞쪽 보장
  const head = ranked.filter((h) => hubIds.has(h.id));
  const tail = ranked.filter((h) => !hubIds.has(h.id));
  return [...head, ...tail].slice(0, Math.max(k, head.length));
}
