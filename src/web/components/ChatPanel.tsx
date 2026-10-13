import { useEffect, useRef, useState, type FormEvent } from 'react';
import { askChat, type ChatReply, type YearScope } from '../api';
import './ChatPanel.css';

interface Turn {
  id: number;
  question: string;
  reply?: ChatReply;
  error?: string;
}

const EXAMPLES = [
  'Top 5 stories about ClickHouse',
  'How did Rust mentions change by year?',
  'Which domains had the most stories in 2024?',
];
const number = new Intl.NumberFormat('en');

function Results({ reply }: { reply: ChatReply }) {
  if (!reply.rows.length || !reply.columns.length) return null;
  return (
    <div className="hn-chat-results" tabIndex={0} role="region" aria-label="Query results">
      <table>
        <thead><tr>{reply.columns.map((col) => <th key={col.key}>{col.label}</th>)}</tr></thead>
        <tbody>{reply.rows.map((row, index) => (
          <tr key={String(row.id ?? index)}>{reply.columns.map((col) => {
            const value = row[col.key];
            const text = value == null ? '—' : String(value);
            const id = String(row.id ?? '');
            return <td key={col.key}>
              {col.format === 'story' && /^\d+$/.test(id)
                ? <a href={`https://news.ycombinator.com/item?id=${id}`} target="_blank" rel="noreferrer">{text || '(untitled)'}</a>
                : col.format === 'number' && Number.isFinite(Number(value)) ? number.format(Number(value))
                : col.format === 'date' ? text.slice(0, 10) : text}
            </td>;
          })}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function ChatPanel({ year, ready }: { year: YearScope; ready: boolean }) {
  const [open, setOpen] = useState(true);
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const sessionId = useRef(crypto.randomUUID());
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (turns.length) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns, loading]);

  const send = async (question: string) => {
    if (!question.trim() || loading || !ready) return;
    const controller = new AbortController();
    active.current = controller;
    const id = ++sequence.current;
    const history = turns.filter((t) => t.reply).slice(-3).flatMap((t) => [
      { role: 'user' as const, content: t.question },
      { role: 'assistant' as const, content: `${t.reply!.answer} ${t.reply!.scope}`.slice(0, 1_500) },
    ]);
    setTurns((current) => [...current, { id, question: question.trim() }]);
    setInput('');
    setLoading(true);
    try {
      const reply = await askChat(question.trim(), year, history, sessionId.current, controller.signal);
      if (active.current !== controller) return;
      setTurns((current) => current.map((t) => t.id === id ? { ...t, reply } : t));
    } catch (err) {
      if (active.current !== controller) return;
      setTurns((current) => current.map((t) => t.id === id ? { ...t,
        error: controller.signal.aborted ? 'Request stopped.' : (err as Error).message } : t));
    } finally {
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
        textarea.current?.focus();
      }
    }
  };

  const clear = () => {
    active.current?.abort();
    active.current = null;
    sessionId.current = crypto.randomUUID();
    setLoading(false);
    setTurns([]);
    textarea.current?.focus();
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void send(input); };

  return (
    <section className="hn-chat" aria-label="Ask HackerNews">
      <div className="hn-chat-heading">
        <div>
          <h2>Ask HackerNews <span className="hn-chat-badge">AI</span></h2>
          <p>Find stories and explore the numbers. <span>{year ?? 'All time'}</span></p>
        </div>
        <div className="hn-chat-controls">
          {turns.length > 0 && <button type="button" onClick={clear}>Clear chat</button>}
          <button type="button" aria-expanded={open} aria-controls="hn-chat-body" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      {open && <div id="hn-chat-body">
        {!ready ? <p className="hn-chat-setup" role="status">Chat is enabled but the inference service isn’t configured yet.</p> : <>
          {turns.length === 0 && <div className="hn-chat-examples">
            {EXAMPLES.map((example) => <button type="button" key={example} onClick={() => void send(example)}>{example} <span aria-hidden="true">↗</span></button>)}
          </div>}
          {turns.length > 0 && <div className="hn-chat-conversation" aria-label="Conversation">
            {turns.map((turn) => <article key={turn.id} className="hn-chat-turn">
              <div className="hn-chat-question"><span className="hn-chat-speaker">You</span><p>{turn.question}</p></div>
              {turn.reply && <div className="hn-chat-answer">
                <p>{turn.reply.answer}</p>
                {turn.reply.scope && <p className="hn-chat-scope">{turn.reply.scope}</p>}
                <Results reply={turn.reply} />
                <small>{(turn.reply.elapsedMs / 1_000).toFixed(1)}s</small>
              </div>}
              {turn.error && <p className="hn-chat-error" role="alert">{turn.error}</p>}
            </article>)}
            {loading && <p className="hn-chat-loading" role="status">Looking up HackerNews data…</p>}
            <div ref={bottom} />
          </div>}
          <form className="hn-chat-form" onSubmit={submit}>
            <label className="hn-chat-sr-only" htmlFor="hn-chat-input">Ask a question about HackerNews</label>
            <textarea id="hn-chat-input" ref={textarea} value={input} rows={1} maxLength={1_000}
              placeholder={turns.length ? 'Ask a follow-up…' : 'Ask about a topic, top stories, or trends…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault(); void send(input);
                }
              }} />
            {loading ? <button type="button" className="hn-chat-send" onClick={() => active.current?.abort()}>Stop</button>
              : <button type="submit" className="hn-chat-send" disabled={!input.trim()}>Ask <span aria-hidden="true">↑</span></button>}
          </form>
          <p className="hn-chat-footnote">Answers use story titles, points, and comment counts. Ask for a year to change the scope.</p>
        </>}
      </div>}
    </section>
  );
}
