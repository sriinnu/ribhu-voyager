import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";

import { Markdown } from "./Markdown";
import {
  approvalPreview,
  buildTimeline,
  busyOf,
  modelOf,
  type Block,
  type Item,
} from "./format";
import { session, type Status } from "./session";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const SUGGESTIONS = [
  "What is durable about this?",
  "run: uname -a",
  "Write a haiku about durable systems",
];

function statusLabel(status: Status): string {
  switch (status) {
    case "online":
      return "Live";
    case "offline":
      return "Offline";
    case "reconnecting":
      return "Reconnecting";
    case "connecting":
      return "Connecting";
    default:
      return "Restoring";
  }
}

function IconArrow() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M12 19V5M12 5l-6 6M12 5l6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconStop() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ToolCard({ block }: { block: Extract<Block, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const output = block.live?.output ?? block.result?.text ?? "";
  const running =
    block.result === undefined &&
    (block.live?.status === "running" || block.live?.status === "pending");
  const failed = block.result?.isError === true;
  const status = running ? "running" : failed ? "error" : block.result ? "done" : "waiting";

  const command =
    typeof block.args.command === "string" ? block.args.command : undefined;
  const summary =
    command ??
    (typeof block.args.path === "string"
      ? block.args.path
      : Object.keys(block.args).length > 0
        ? JSON.stringify(block.args)
        : "");

  const lines = output.split("\n").filter((line, index, all) => {
    return !(index === all.length - 1 && line === "");
  });
  const preview = lines.slice(0, 6).join("\n");
  const expandable = lines.length > 6;

  return (
    <div className={`tool ${failed ? "tool--error" : ""}`}>
      <button
        type="button"
        className="tool-head"
        onClick={() => (expandable || running ? setOpen((value) => !value) : undefined)}
        aria-expanded={expandable ? open : undefined}
      >
        <span className={`tool-status tool-status--${status}`} aria-hidden="true">
          {status === "done" ? "✓" : status === "error" ? "!" : status === "running" ? "" : "·"}
        </span>
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary">{summary}</span>
        {running ? <span className="tool-live">live</span> : null}
        {expandable ? <span className="tool-chevron">{open ? "−" : "+"}</span> : null}
      </button>
      {output !== "" ? (
        <pre className={`tool-output ${open ? "tool-output--open" : ""}`}>
          {open || running ? output : preview}
          {expandable && !open ? "\n…" : ""}
        </pre>
      ) : running ? (
        <pre className="tool-output">waiting for output…</pre>
      ) : null}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  return (
    <details className="thinking">
      <summary>Thinking</summary>
      <div>{text}</div>
    </details>
  );
}

function ApprovalCard({ item }: { item: Extract<Item, { kind: "approval" }> }) {
  const { approval } = item;
  const pending = approval.status === "pending";
  const [sending, setSending] = useState<"approve" | "deny" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Decisions come back through the journaled view update; clear the in-flight
  // marker as soon as the card is no longer pending.
  useEffect(() => {
    if (!pending) {
      setSending(null);
      setNote(null);
    }
  }, [pending]);

  // If the socket drops mid-decision the gateway never sees it: re-enable so
  // the user can retry once the connection is back.
  useEffect(() => {
    if (sending === null) return;
    const timer = setTimeout(() => {
      setSending(null);
      setNote("No response from the gateway — try again.");
    }, 12_000);
    return () => clearTimeout(timer);
  }, [sending]);

  const decide = (decision: "approve" | "deny") => {
    setSending(decision);
    setNote(null);
    if (!session.decideApproval(approval.callId, decision)) {
      setSending(null);
      setNote("Not connected — reconnect and try again.");
    }
  };

  const preview = approvalPreview(approval);
  const decided =
    approval.status === "approved"
      ? "Approved"
      : approval.status === "denied"
        ? "Denied"
        : null;

  return (
    <section
      className={`approval approval--${approval.status}`}
      aria-label={`Tool approval ${approval.status}: ${approval.name}`}
    >
      <div className="approval-head">
        <span className="approval-mark" aria-hidden="true">
          {approval.status === "approved" ? "✓" : approval.status === "denied" ? "×" : "!"}
        </span>
        <span className="approval-label">
          {pending ? "Approval needed" : "Tool call"}
        </span>
        <span className="approval-tool">{approval.name}</span>
        {decided ? <span className="approval-badge">{decided}</span> : null}
      </div>
      {preview !== "" ? <pre className="approval-args">{preview}</pre> : null}
      {pending ? (
        <div className="approval-actions" role="group" aria-label="Decide tool call">
          <button
            type="button"
            className="approval-approve"
            disabled={sending !== null}
            onClick={() => decide("approve")}
          >
            {sending === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            className="approval-deny"
            disabled={sending !== null}
            onClick={() => decide("deny")}
          >
            {sending === "deny" ? "Denying…" : "Deny"}
          </button>
        </div>
      ) : null}
      {note ? <p className="approval-note">{note}</p> : null}
    </section>
  );
}

function AssistantMessage({ item }: { item: Extract<Item, { kind: "assistant" }> }) {
  return (
    <article className={`msg assistant ${item.interrupted ? "is-interrupted" : ""}`}>
      <div className="who">
        <img className="who-mark" src="/icons/icon.svg" alt="" aria-hidden="true" />
        <span className="who-name">Ribhu</span>
        {item.streaming ? <span className="streaming-tag">streaming</span> : null}
      </div>
      {item.blocks.map((block, index) => {
        if (block.type === "text") {
          return <Markdown key={index} text={block.text} />;
        }
        if (block.type === "thinking") {
          return <Thinking key={index} text={block.text} />;
        }
        return <ToolCard key={index} block={block} />;
      })}
      {item.streaming ? <span className="caret" aria-hidden="true" /> : null}
      {item.interrupted ? (
        <div className="interrupted">
          <span aria-hidden="true">‖</span> Interrupted — this answer did not finish.
        </div>
      ) : null}
    </article>
  );
}

function QueuedMessage({ item }: { item: Extract<Item, { kind: "queued" }> }) {
  const failed = item.state === "failed";
  return (
    <div className={`msg user queued ${failed ? "queued--failed" : ""}`}>
      <div className="bubble">{item.text}</div>
      <div className="queued-meta">
        {failed ? (
          <>
            <span>Could not send: {item.error ?? "unknown error"}</span>
            <button type="button" onClick={() => session.retry(item.requestId)}>
              Retry
            </button>
            <button type="button" onClick={() => session.discard(item.requestId)}>
              Discard
            </button>
          </>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <span>{item.state === "sending" ? "Sending…" : "Queued — sends when reconnected"}</span>
          </>
        )}
      </div>
    </div>
  );
}

function MessageItem({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case "assistant":
      return <AssistantMessage item={item} />;
    case "approval":
      return <ApprovalCard item={item} />;
    case "queued":
      return <QueuedMessage item={item} />;
    case "notice":
      return <div className={`notice ${item.tone}`}>{item.text}</div>;
    default:
      return null;
  }
}

function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="scrim" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Session menu"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

export function App() {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const timeline = useMemo(
    () =>
      buildTimeline(
        state.view,
        state.outbox.map((item) => ({
          requestId: item.requestId,
          content: item.content,
          state: item.state,
          error: item.error,
        })),
      ),
    [state.view, state.outbox],
  );

  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"steer" | "followUp">("steer");
  const [menu, setMenu] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [installEvent, setInstallEvent] = useState<InstallPrompt | null>(null);
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const model = state.info?.demo
    ? "demo"
    : state.info?.model ?? modelOf(state.view) ?? "…";
  const auth = state.info?.auth ?? null;
  const busy = timeline.busy || busyOf(state.view);
  const queued = state.outbox.filter((item) => item.state !== "failed").length;

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    setHiddenError(null);
  }, [state.error]);

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [state.view, state.outbox.length]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [draft]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const bottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    stick.current = bottom;
    setAtBottom(bottom);
  };

  const send = useCallback(
    (text?: string) => {
      const message = (text ?? draft).trim();
      if (message === "") return;
      session.submit(message, busy ? mode : "steer");
      setDraft("");
      setMode("steer");
      stick.current = true;
      setAtBottom(true);
      requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (element) element.scrollTop = element.scrollHeight;
      });
    },
    [draft, busy, mode],
  );

  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    setInstallEvent(null);
  };

  const copyDiagnostics = async () => {
    const payload = {
      protocol: 1,
      status: state.status,
      conversationId: state.conversationId,
      cursor: state.cursor,
      entries: state.view?.entries.length ?? 0,
      outbox: state.outbox.length,
      server: state.info?.serverId,
      provider: state.info?.provider,
      model: state.info?.model,
      userAgent: navigator.userAgent,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      /* clipboard unavailable */
    }
  };

  const label = statusLabel(state.status);
  const errorVisible = state.error !== null && state.error !== hiddenError;
  const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !(navigator as unknown as { standalone?: boolean }).standalone;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img className="brand-mark" src="/icons/ribhu-mark.svg" alt="" />
          <span className="brand-name">Ribhu</span>
          <span className="brand-sub">Voyager</span>
        </div>
        <div className="head-right">
          <span className={`model-chip ${state.info?.demo ? "is-demo" : ""}`}>{model}</span>
          <span className={`conn conn--${state.status}`} title={label}>
            <span className="conn-dot" aria-hidden="true" />
            <span className="conn-label">{label}</span>
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setMenu(true)}
            aria-label="Open session menu"
          >
            <IconMore />
          </button>
        </div>
      </header>

      <main className="scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="thread">
          {timeline.hasEarlier ? (
            <div className="notice muted">
              Earlier messages are not loaded. The full transcript is still on the gateway.
            </div>
          ) : null}

          {timeline.items.length === 0 ? (
            <section className="empty">
              <div className="empty-mark" aria-hidden="true">
                <img src="/icons/ribhu-mark.svg" alt="" />
              </div>
              <h1>Ribhu Voyager</h1>
              <p className="empty-tagline">
                A durable coding agent that goes the distance. Kill the gateway, lose the
                network, or close the app — the conversation continues.
              </p>
              <div className="chips">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => send(suggestion)}
                    className={suggestion.startsWith("run:") ? "chip chip--code" : "chip"}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
              <p className="empty-foot">
                {state.info?.demo
                  ? "Scripted demo model · native Ribhu engine"
                  : `Connected to ${state.info?.provider ?? "pi"}/${state.info?.model ?? "…"}`}
              </p>
            </section>
          ) : null}

          {timeline.items.map((item) => (
            <MessageItem key={item.id} item={item} />
          ))}

          {timeline.failure ? (
            <div className="failure">
              <strong>Run ended without an answer</strong>
              <span>
                {timeline.failure.reason}
                {timeline.failure.detail ? ` — ${timeline.failure.detail}` : ""}
              </span>
              <button type="button" onClick={() => session.submit("Continue.", "steer")}>
                Continue
              </button>
            </div>
          ) : null}

          <div className="thread-end" />
        </div>

        {!atBottom && timeline.items.length > 0 ? (
          <button
            type="button"
            className="jump"
            onClick={() => {
              stick.current = true;
              const element = scrollRef.current;
              if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
            }}
          >
            ↓ Latest
          </button>
        ) : null}
      </main>

      {state.status === "offline" || state.status === "reconnecting" ? (
        <div className="banner">
          <span className="banner-dot" aria-hidden="true" />
          <span>
            {state.status === "offline" ? "Offline" : "Reconnecting…"}
            {queued > 0 ? ` · ${queued} queued` : ""}
          </span>
          <button type="button" onClick={() => session.reconnectNow()}>
            Retry now
          </button>
        </div>
      ) : null}

      {errorVisible ? (
        <div className="banner banner--error" role="alert">
          <span>{state.error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setHiddenError(state.error)}>
            <IconClose />
          </button>
        </div>
      ) : null}

      <footer className="composer-wrap">
        {busy ? (
          <div className="work">
            <span className="pulse" aria-hidden="true" />
            <span className="work-label">Working</span>
            {elapsed > 0 ? <span className="work-meta">{elapsed}s</span> : null}
            {timeline.streaming ? <span className="work-meta">streaming</span> : null}
            <div className="work-actions">
              <div className="seg" role="group" aria-label="How to send while busy">
                <button
                  type="button"
                  aria-pressed={mode === "steer"}
                  className={mode === "steer" ? "is-on" : ""}
                  onClick={() => setMode("steer")}
                >
                  Steer
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "followUp"}
                  className={mode === "followUp" ? "is-on" : ""}
                  onClick={() => setMode("followUp")}
                >
                  Queue
                </button>
              </div>
              <button type="button" className="stop" onClick={() => session.abort()}>
                <IconStop />
                Stop
              </button>
            </div>
          </div>
        ) : null}

        <div className="composer">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={busy ? "Steer or queue a message…" : "Message Ribhu…"}
            aria-label="Message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            className="send"
            onClick={() => send()}
            disabled={draft.trim() === ""}
            aria-label="Send message"
          >
            <IconArrow />
          </button>
        </div>
        <div className="hint">
          {state.status === "offline" || state.status === "reconnecting"
            ? `Queued locally${queued > 0 ? ` · ${queued}` : ""} — sends when the gateway is back`
            : busy
              ? mode === "steer"
                ? "Steer interrupts the current tool call."
                : "Queue waits for the current answer."
              : coarsePointer
                ? "Tap ↑ to send"
                : "Enter to send · Shift+Enter for a new line"}
          {state.info?.demo ? " · demo model" : ""}
        </div>
      </footer>

      <Sheet
        open={menu}
        onClose={() => {
          setMenu(false);
          setConfirmClear(false);
        }}
      >
        <div className="sheet-head">
          <h2>Session</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close menu"
            onClick={() => {
              setMenu(false);
              setConfirmClear(false);
            }}
          >
            <IconClose />
          </button>
        </div>

        <div className="conv-head">
          <h3>Conversations</h3>
          <button
            type="button"
            className="conv-new"
            onClick={() => {
              session.newConversation();
              setMenu(false);
            }}
          >
            New
          </button>
        </div>
        <div className="conv-list">
          {state.conversations.length === 0 ? (
            <p className="fine">No conversations loaded yet.</p>
          ) : (
            state.conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={
                  conversation.id === state.conversationId
                    ? "conv is-active"
                    : "conv"
                }
                onClick={() => {
                  session.switchConversation(conversation.id);
                  setMenu(false);
                }}
              >
                <span>{conversation.title}</span>
                {conversation.parentId ? <small>fork</small> : null}
              </button>
            ))
          )}
        </div>
        {state.archivedConversations.length > 0 ? (
          <div className="conv-archived">
            <h3>Archived</h3>
            {state.archivedConversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className="conv is-archived"
                onClick={() => session.archiveConversation(conversation.id, false)}
              >
                <span>{conversation.title}</span>
                <small>Restore</small>
              </button>
            ))}
          </div>
        ) : null}

        <input
          className="conv-search"
          value={query}
          placeholder="Search conversations…"
          aria-label="Search conversations"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") session.search(query);
          }}
        />
        {state.searchResults.length > 0 ? (
          <div className="conv-results">
            {state.searchResults.map((result) => (
              <button
                key={result.id}
                type="button"
                className="conv-result"
                onClick={() => {
                  session.switchConversation(result.id);
                  setQuery("");
                  session.search("");
                  setMenu(false);
                }}
              >
                <b>{result.title}</b>
                {result.snippet ? <small>{result.snippet}</small> : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="conv-actions">
          <button
            type="button"
            onClick={() => {
              session.forkConversation();
              setMenu(false);
            }}
          >
            Fork this chat
          </button>
          <button
            type="button"
            onClick={() => {
              const current = state.conversations.find(
                (conversation) => conversation.id === state.conversationId,
              );
              const title = window.prompt("Rename conversation", current?.title ?? "");
              if (title?.trim()) session.renameConversation(state.conversationId ?? 0, title);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              session.compact();
              setMenu(false);
            }}
          >
            Compact
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (state.conversationId !== null) {
                session.archiveConversation(state.conversationId);
              }
              setMenu(false);
            }}
          >
            Archive
          </button>
        </div>

        <div className="kv">
          <span>Connection</span>
          <b className={`kv-status kv-status--${state.status}`}>{label}</b>
        </div>
        <div className="kv">
          <span>Model</span>
          <b>{state.info?.demo ? "Pi Demo (scripted)" : model}</b>
        </div>
        {auth ? (
          <>
            <div className="kv">
              <span>Anthropic auth</span>
              <b>{auth.label}</b>
            </div>
            <div className="auth-choice" role="group" aria-label="Anthropic authentication">
              <button
                type="button"
                className={auth.mode === "subscription" ? "is-on" : ""}
                disabled={!auth.subscriptionAvailable}
                onClick={() => session.setAuth("subscription")}
              >
                Subscription
              </button>
              <button
                type="button"
                className={auth.mode === "api-key" ? "is-on" : ""}
                disabled={!auth.apiKeyAvailable}
                onClick={() => session.setAuth("api-key")}
              >
                API credits
              </button>
            </div>
            {auth.detail ? <p className="fine auth-detail">{auth.detail}</p> : null}
          </>
        ) : null}
        <div className="kv">
          <span>Harness</span>
          <b>Ribhu Engine 0.1</b>
        </div>
        <div className="kv">
          <span>Storage</span>
          <b>SQLite on the gateway</b>
        </div>
        <div className="kv">
          <span>Local cache</span>
          <b>
            {state.view?.entries.length ?? 0} entries · cursor {state.cursor}
          </b>
        </div>

        <div className="sheet-actions">
          <button
            type="button"
            onClick={() => {
              session.resync();
              setMenu(false);
            }}
          >
            Force resync
          </button>
          {installEvent ? (
            <button type="button" onClick={() => void install()}>
              Install app
            </button>
          ) : null}
          <button type="button" onClick={() => void copyDiagnostics()}>
            Copy diagnostics
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => setConfirmClear(true)}
          >
            Clear local cache
          </button>
        </div>

        {confirmClear ? (
          <div className="confirm">
            <p>
              This clears the copy on this phone only. The gateway keeps the transcript, and
              it will be re-downloaded on reconnect.
            </p>
            <div className="confirm-actions">
              <button type="button" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void session.clearLocal();
                  setConfirmClear(false);
                  setMenu(false);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        ) : null}

        {isIos ? (
          <p className="fine">
            To install on iOS, open the Share menu and choose “Add to Home Screen”.
          </p>
        ) : null}

        <p className="fine">
          Ribhu Voyager 0.1 · protocol v2. The transcript, streaming partials and tool output are
          committed by the gateway before they are shown here.
        </p>
      </Sheet>
    </div>
  );
}
