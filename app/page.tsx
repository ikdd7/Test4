import Chat from "./components/Chat";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">🚒 소방 법령 안내</span>
      </header>
      <Chat />
    </div>
  );
}
