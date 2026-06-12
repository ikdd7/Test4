"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type Source = { type: string; title: string; article: string | null; date: string };
type Msg = { role: "user" | "assistant"; content: string; sources?: Source[] };

// 인라인 마크다운: **굵게**, `코드`
function inlineParse(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<strong key={i++}>{m[1]}</strong>);
    else parts.push(<code key={i++}>{m[2]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// 줄 단위: # 제목 → 굵게, * / - 글머리 → •
function renderRich(text: string): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, idx) => {
    const tail = idx < lines.length - 1 ? "\n" : "";
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      return (
        <span key={idx}>
          <strong>{inlineParse(h[2])}</strong>
          {tail}
        </span>
      );
    }
    const bulleted = line.replace(/^(\s*)[*-]\s+/, "$1• ");
    return (
      <span key={idx}>
        {inlineParse(bulleted)}
        {tail}
      </span>
    );
  });
}

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);

  // 음성 인식(브라우저 내장 Web Speech API — 키·비용 없음)
  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setMicSupported(!!SR);
  }, []);

  function toggleMic() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const base = input.trim() ? input.trim() + " " : "";
    rec.onresult = (e: any) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(base + txt);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recogRef.current = rec;
    setListening(true);
    rec.start();
  }

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
              {m.role === "assistant" ? renderRich(m.content) : m.content}
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
        <div className="ta-wrap">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              listening
                ? "말씀하세요… (음성 인식 중)"
                : "예) 소방시설법 제13조 알려줘 / 11층 업무시설에 스프링클러 설치 대상인가요?"
            }
          />
          {micSupported && (
            <button
              type="button"
              className={`mic ${listening ? "on" : ""}`}
              onClick={toggleMic}
              title={listening ? "듣는 중… (눌러서 중지)" : "음성으로 질문하기"}
              aria-label="음성 입력"
            >
              {listening ? "■" : "🎤"}
            </button>
          )}
        </div>
        <button disabled={busy || !input.trim()}>전송</button>
      </form>
    </>
  );
}
