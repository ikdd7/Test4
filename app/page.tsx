import Chat from "./components/Chat";
import { DISCLAIMER } from "@/lib/prompt";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <div className="wrap">
      <header className="bar">
        <h1>🔥 소방 법령 안내 도구</h1>
        <p>근거 조문을 찾아 보여주는 도구 · 법률 자문이 아닙니다</p>
      </header>
      <Chat />
      <div className="disclaimer">※ {DISCLAIMER}</div>
    </div>
  );
}
