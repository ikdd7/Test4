"use client";

import { useRef, useState } from "react";

type Source = { type: string; title: string; article: string | null; date: string };
type Msg = { role: "user" | "assistant"; content: string; sources?: Source[] };

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  function scrollDown() {
    requestAnimationFrame(() => {
      chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
    });
  }

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const q = input.trim();
    if (!q || busy) return;

    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setBusy(true);
    scrollDown();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      const data = await res.json();
      setMessages([
        ...next,
        {
          role: "assistant",
          content: data.answer || data.error || "응답을 받지 못했습니다.",
          sources: data.sources,
        },
      ]);
    } catch {
      setMessages([...next, { role: "assistant", content: "네트워크 오류가 발생했습니다." }]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <div className="chat" ref={chatRef}>
        <div className="intro">
          안녕하세요. <b>대한민국 소방 법령 안내 도구</b>입니다. 소방시설법·화재예방법과 그 시행령·
          시행규칙·별표·고시·질의회신을 근거로 <b>조문을 찾아 보여드립니다</b>.
          <br />※ 본 도구는 법령 정보 안내이며 <b>법률 자문이 아닙니다</b>. 최종 판단은 원문 확인 및
          관할 소방서·전문가 확인을 거치세요.
        </div>

        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="bubble">
              {m.content}
              {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                <details className="sources">
                  <summary>검색된 근거 자료 {m.sources.length}건</summary>
                  <ul>
                    {m.sources.map((s, j) => (
                      <li key={j}>
                        [{s.type}] {s.title}
                        {s.article ? ` ${s.article}` : ""} · {s.date}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="msg assistant">
            <div className="bubble">
              여러 단계로 검색하고 근거를 교차검증하는 중…
              <br />
              <span style={{ fontSize: 12, color: "#888" }}>
                (정확도를 위해 다단계로 처리합니다 · 최대 1~2분 걸릴 수 있어요)
              </span>
            </div>
          </div>
        )}
      </div>

      <form className="inputbar" onSubmit={send}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="예) 소방시설법 제13조 알려줘 / 11층 업무시설에 스프링클러 설치 대상인가요?"
        />
        <button disabled={busy || !input.trim()}>전송</button>
      </form>
    </>
  );
}
