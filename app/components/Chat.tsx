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
  const abortRef = useRef<AbortController | null>(null);

  // 음성 인식(브라우저 내장 Web Speech API — 키·비용 없음)
  const [micSupported, setMicSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [micMsg, setMicMsg] = useState("");
  const recogRef = useRef<any>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    setMicSupported(!!SR);
  }, []);

  function micErrorText(code: string): string {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        return "마이크 권한이 거부되었습니다. 주소창의 🔒(자물쇠) → 마이크 ‘허용’ 후 다시 시도하세요.";
      case "no-speech":
        return "음성이 감지되지 않았습니다. 🎤를 다시 눌러 또렷이 말씀해 주세요.";
      case "audio-capture":
        return "마이크를 찾을 수 없습니다. 기기 마이크를 확인하세요.";
      case "network":
        return "음성 인식 서버 연결 오류(네트워크). 잠시 후 다시 시도하세요.";
      default:
        return "음성 인식 오류: " + code;
    }
  }

  function toggleMic() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    setMicMsg("");
    const rec = new SR();
    rec.lang = "ko-KR";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    const base = input.trim() ? input.trim() + " " : "";
    rec.onstart = () => {
      setListening(true);
      taRef.current?.focus(); // 입력창에 커서가 깜빡이도록
    };
    rec.onresult = (e: any) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setInput(base + txt);
      taRef.current?.focus();
    };
    rec.onerror = (e: any) => {
      setListening(false);
      setMicMsg(micErrorText(e?.error || "unknown"));
    };
    rec.onend = () => setListening(false);
    recogRef.current = rec;
    taRef.current?.focus();
    try {
      rec.start();
    } catch {
      // 이미 시작된 경우 등 — 무시
    }
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

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
        signal: ctrl.signal,
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
    } catch (err: any) {
      if (err?.name === "AbortError") {
        setMessages([...next, { role: "assistant", content: "⏹️ 요청을 중지했습니다." }]);
      } else {
        setMessages([...next, { role: "assistant", content: "네트워크 오류가 발생했습니다." }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      scrollDown();
    }
  }

  function stop() {
    abortRef.current?.abort();
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

      {micMsg && <div className="mic-msg">{micMsg}</div>}
      <form className="inputbar" onSubmit={send}>
        <div className="ta-wrap">
          <textarea
            ref={taRef}
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
        {busy ? (
          <button type="button" className="stop" onClick={stop} aria-label="응답 중지" title="응답 중지">
            ■ 중지
          </button>
        ) : (
          <button disabled={!input.trim()}>전송</button>
        )}
      </form>
    </>
  );
}
