'use client';

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  KeyboardEvent,
} from 'react';
import { cn } from '@/lib/utils';
import {
  IconTerminal2,
  IconSend,
  IconChevronDown,
  IconPlugConnected,
  IconPlugConnectedX,
  IconEraser,
  IconHistory,
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StreamEvent {
  type: 'connected' | 'line' | 'history_end' | 'ping';
  text?: string;
  agent?: string;
}

interface LogLine {
  id: number;
  text: string;
  isHistory: boolean;
}

// ---------------------------------------------------------------------------
// Line classifier — simple heuristic coloring
// ---------------------------------------------------------------------------

function lineClass(text: string): string {
  const t = text.trimStart();
  if (
    t.startsWith('╔') || t.startsWith('║') || t.startsWith('╚') ||
    t.startsWith('┌') || t.startsWith('│') || t.startsWith('└')
  ) return 'text-blue-400';
  if (t.includes('✓') || t.includes('✔') || t.startsWith('Done')) return 'text-green-400';
  if (
    t.startsWith('Error') || t.startsWith('error') ||
    t.includes('✗') || t.includes('FAILED') || t.startsWith('ALVORLIG')
  ) return 'text-red-400';
  if (
    t.startsWith('⚡') || t.startsWith('Tool:') || t.startsWith('Bash') ||
    t.startsWith('Read ') || t.startsWith('Write ') || t.startsWith('Edit ')
  ) return 'text-yellow-400';
  if (t.startsWith('>') || t.startsWith('?') || t.includes('…')) return 'text-cyan-400';
  if (t.startsWith('#') || t.startsWith('//')) return 'text-muted-foreground';
  return 'text-foreground/90';
}

// ---------------------------------------------------------------------------
// Shortcut keys for mobile virtual keyboard
// ---------------------------------------------------------------------------

const SHORTCUTS = [
  { label: 'Esc', value: '\x1b' },
  { label: 'Tab', value: '\t' },
  { label: 'Ctrl+C', value: '\x03' },
  { label: '↑', value: '__HISTORY_UP__' },
  { label: '/help', value: '/help' },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ClaudeTerminalProps {
  agents: string[];
  defaultAgent: string;
}

export function ClaudeTerminal({ agents, defaultAgent }: ClaudeTerminalProps) {
  const [agent, setAgent] = useState(defaultAgent);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [newLines, setNewLines] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [sending, setSending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const lineCounter = useRef(0);
  const isHistoryPhase = useRef(true);

  // -------------------------------------------------------------------------
  // Connect / reconnect SSE
  // -------------------------------------------------------------------------

  const connect = useCallback((agentName: string) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setConnected(false);
    setLoadingHistory(true);
    setLines([]);
    isHistoryPhase.current = true;
    lineCounter.current = 0;

    const es = new EventSource(`/api/claude/${encodeURIComponent(agentName)}/stream`);
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (e: MessageEvent) => {
      try {
        const ev: StreamEvent = JSON.parse(e.data);
        if (ev.type === 'ping') return;
        if (ev.type === 'history_end') {
          isHistoryPhase.current = false;
          setLoadingHistory(false);
          return;
        }
        if (ev.type === 'line' && ev.text) {
          const id = ++lineCounter.current;
          const isHistory = isHistoryPhase.current;
          setLines((prev) => {
            const next = [...prev, { id, text: ev.text!, isHistory }];
            // Keep max 2000 lines in memory
            return next.length > 2000 ? next.slice(-2000) : next;
          });
          if (!isHistory && !atBottom) {
            setNewLines((n) => n + 1);
          }
        }
      } catch { /* malformed */ }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      // Auto-reconnect in 4 s
      setTimeout(() => connect(agentName), 4000);
    };
  }, [atBottom]);

  useEffect(() => {
    connect(agent);
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // -------------------------------------------------------------------------
  // Auto-scroll
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (atBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, atBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(isBottom);
    if (isBottom) setNewLines(0);
  };

  const scrollToBottom = () => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    setAtBottom(true);
    setNewLines(0);
  };

  // -------------------------------------------------------------------------
  // Send input
  // -------------------------------------------------------------------------

  const send = useCallback(async (text: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setHistory((h) => [text, ...h.slice(0, 99)]);
    setHistIdx(-1);
    setInput('');
    try {
      await fetch(`/api/claude/${encodeURIComponent(agent)}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [agent, sending]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
      return;
    }
    if (e.key === 'ArrowUp' && !input) {
      e.preventDefault();
      const idx = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      setInput(history[idx] ?? '');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = Math.max(histIdx - 1, -1);
      setHistIdx(idx);
      setInput(idx < 0 ? '' : history[idx] ?? '');
    }
  };

  const handleShortcut = (value: string) => {
    if (value === '__HISTORY_UP__') {
      const idx = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      setInput(history[idx] ?? '');
      return;
    }
    send(value);
  };

  const clearLines = () => setLines([]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] md:h-[calc(100vh-3.5rem)] -mx-4 md:-mx-6 -my-4 md:-my-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b bg-card/50 shrink-0">
        <IconTerminal2 size={18} className="text-primary shrink-0" />

        {/* Agent selector */}
        <div className="relative flex-1 min-w-0">
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="w-full appearance-none bg-background border rounded-md px-3 py-1.5 text-sm font-mono pr-8 focus:outline-none focus:ring-1 focus:ring-primary truncate"
          >
            {agents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <IconChevronDown
            size={14}
            className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-muted-foreground"
          />
        </div>

        {/* Status */}
        <div className="flex items-center gap-1.5 shrink-0">
          {connected ? (
            <IconPlugConnected size={16} className="text-green-500" />
          ) : (
            <IconPlugConnectedX size={16} className="text-red-500 animate-pulse" />
          )}
          <span className="text-[11px] text-muted-foreground hidden sm:block">
            {connected ? 'live' : 'reconnecting…'}
          </span>
        </div>

        {/* Clear */}
        <button
          onClick={clearLines}
          title="Clear output"
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
        >
          <IconEraser size={15} />
        </button>
      </div>

      {/* Output area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[12px] leading-relaxed bg-background px-3 py-2 min-h-0"
      >
        {loadingHistory && (
          <div className="text-muted-foreground/50 text-[11px] py-1 flex items-center gap-1.5">
            <IconHistory size={12} className="animate-spin" />
            Loading history…
          </div>
        )}

        {lines.map((line) => (
          <div
            key={line.id}
            className={cn(
              'whitespace-pre-wrap break-all py-[1px]',
              line.isHistory ? 'opacity-60' : 'opacity-100',
              lineClass(line.text),
            )}
          >
            {line.text}
          </div>
        ))}

        {lines.length === 0 && !loadingHistory && (
          <div className="text-muted-foreground/40 text-[11px] py-4 text-center">
            No output yet — send a message below to interact with {agent}
          </div>
        )}
      </div>

      {/* Scroll-to-bottom button */}
      {!atBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-[120px] right-4 md:bottom-[80px] flex items-center gap-1 rounded-full bg-primary text-primary-foreground text-[11px] px-3 py-1.5 shadow-lg z-10 transition-all"
        >
          <IconChevronDown size={13} />
          {newLines > 0 ? `${newLines} new` : 'bottom'}
        </button>
      )}

      {/* Mobile keyboard shortcuts */}
      <div className="flex gap-1.5 px-3 py-1.5 border-t bg-card/30 overflow-x-auto shrink-0 md:hidden">
        {SHORTCUTS.map((s) => (
          <button
            key={s.label}
            onClick={() => handleShortcut(s.value)}
            className="shrink-0 rounded border bg-muted/60 px-2.5 py-1 text-[11px] font-mono text-foreground/80 hover:bg-muted active:scale-95 transition-all"
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Input bar */}
      <div className="flex items-end gap-2 px-3 py-2 border-t bg-card/50 shrink-0 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${agent}…`}
          rows={1}
          className={cn(
            'flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm font-mono',
            'placeholder:text-muted-foreground/50',
            'focus:outline-none focus:ring-1 focus:ring-primary',
            'min-h-[38px] max-h-[120px] overflow-y-auto',
          )}
          style={{ height: 'auto' }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 120) + 'px';
          }}
        />
        <button
          onClick={() => send(input)}
          disabled={!input.trim() || sending || !connected}
          className={cn(
            'shrink-0 flex items-center justify-center rounded-md p-2.5',
            'bg-primary text-primary-foreground',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            'hover:bg-primary/90 active:scale-95 transition-all',
          )}
        >
          <IconSend size={16} />
        </button>
      </div>
    </div>
  );
}
