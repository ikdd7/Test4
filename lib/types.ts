// 청크 1건 = 조문 1개 / 별표 1개 / 회신 1건
export interface Chunk {
  id: string;
  type: string; // 자료유형: 법률 | 시행령 | 시행규칙 | 별표 | 고시 | 질의회신 | 법령해석
  title: string; // 법령명 또는 회신제목
  article: string | null; // 조번호("제13조") | 별표번호("별표 4") | 회신번호
  date: string; // 시행일 또는 회신일자 (없으면 "미상")
  parent: string | null; // 상위법 연결 (예: "법 제12조")
  source_file: string; // 원본 파일 경로
  text: string; // 원문 (수정 없이 그대로)
  embedding: number[] | null; // 정규화된 임베딩 벡터 (실패 시 null)
}

export interface IndexFile {
  model: string;
  dim: number;
  chunks: Chunk[];
}

export interface Hit extends Chunk {
  score: number;
}
