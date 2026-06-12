/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transformers.js(onnxruntime)는 정적 번들하지 않음(네이티브 바이너리).
  serverExternalPackages: ["@huggingface/transformers"],
  // 런타임에 fs로 읽는 인덱스 파일을 서버리스 함수에 포함.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/index.json"],
  },
  // 임베딩 관련 대용량 패키지(수백 MB)를 함수 추적에서 제외 → 250MB 한도 초과 방지.
  // (런타임 의미검색은 비활성, 키워드+정확조회로 동작. 의미검색은 인제스트 단계에서 사용.)
  outputFileTracingExcludes: {
    "*": [
      "node_modules/@huggingface/**",
      "node_modules/onnxruntime-node/**",
      "node_modules/onnxruntime-web/**",
      "node_modules/onnxruntime-common/**",
      "node_modules/sharp/**",
      "node_modules/@img/**",
    ],
  },
};

export default nextConfig;
