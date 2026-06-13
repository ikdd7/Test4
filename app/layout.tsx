import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "소방법령 AI",
  description: "소방시설법·화재예방법을 근거로 AI가 답변하는 소방 법령 안내 도구 (법률 자문 아님)",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // 노치·홈 인디케이터 영역(safe-area) 인식
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
