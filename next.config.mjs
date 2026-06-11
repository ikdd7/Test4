/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transformers.js(onnxruntime-node)는 네이티브 바이너리라 번들 대상에서 제외해야 동작합니다.
  serverExternalPackages: ["@huggingface/transformers"],
  // 런타임에 fs로 읽는 인덱스 파일을 서버리스 함수에 포함시킵니다.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/index.json"],
  },
};

export default nextConfig;
