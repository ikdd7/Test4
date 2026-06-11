// 무료 오픈소스 한국어(다국어) 임베딩 — Transformers.js, 별도 키 불필요.
// 런타임에는 "질의(query)"만 임베딩합니다. (코퍼스는 인제스트 단계에서 미리 임베딩)
import { pipeline, env } from "@huggingface/transformers";

export const EMBED_MODEL = "Xenova/multilingual-e5-small"; // dim 384

// Vercel 서버리스에서는 /tmp 만 쓰기 가능 → 모델 캐시 위치 지정
if (process.env.VERCEL) {
  // @ts-ignore
  env.cacheDir = "/tmp/hf-cache";
}

let extractorPromise: Promise<any> | null = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", EMBED_MODEL);
  }
  return extractorPromise;
}

// E5 계열은 query/passage 접두사를 붙여야 성능이 나옵니다.
async function embed(text: string, kind: "query" | "passage"): Promise<number[]> {
  const extractor = await getExtractor();
  const prefixed = (kind === "query" ? "query: " : "passage: ") + text;
  const output = await extractor(prefixed, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export const embedQuery = (text: string) => embed(text, "query");
export const embedPassage = (text: string) => embed(text, "passage");
