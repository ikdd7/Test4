// 무료 오픈소스 한국어(다국어) 임베딩 — Transformers.js, 별도 키 불필요.
// 주의: Vercel 서버리스 함수 용량(250MB)을 넘기지 않도록 "동적 import"로만 로드합니다.
//       (onnxruntime이 수백 MB라 정적 import 시 배포 실패) → next.config 에서 추적 제외.
//       런타임에 이 모듈을 못 불러오면 search()가 키워드 검색으로 자동 폴백합니다.
export const EMBED_MODEL = "Xenova/multilingual-e5-small"; // dim 384

let extractorPromise: Promise<any> | null = null;

async function getExtractor() {
  const { pipeline, env } = await import("@huggingface/transformers");
  if (process.env.VERCEL) {
    try {
      // @ts-ignore
      env.cacheDir = "/tmp/hf-cache";
    } catch {}
  }
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
