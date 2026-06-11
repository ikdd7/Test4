import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "소방 법령 안내 도구",
  description: "대한민국 소방 법령 근거 조문 검색·안내 도구 (법률 자문 아님)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
