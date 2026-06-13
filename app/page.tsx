import Chat from "./components/Chat";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🚒 소방 법령 안내</span>
        <span className="brand-sub">근거 조문 검색 · 법률 자문 아님</span>
      </header>
      <Chat />
    </div>
  );
}
