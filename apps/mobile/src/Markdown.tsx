import { useState } from "react";
import type { ReactNode } from "react";

type Block =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "hr" };

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  const pattern = new RegExp(INLINE.source, "g");

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code className="inline-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      nodes.push(
        <a
          key={key}
          href={link?.[2] ?? "#"}
          target="_blank"
          rel="noreferrer noopener"
        >
          {link?.[1] ?? token}
        </a>,
      );
    }
    last = match.index + token.length;
  }

  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function parse(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1]?.trim() ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", lang, code: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length,
        text: heading[2]!,
      });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: body.join(" ") });
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!) &&
      !/^(#{1,3})\s+/.test(lines[i]!) &&
      !/^[-*+]\s+/.test(lines[i]!) &&
      !/^\d+\.\s+/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!)
    ) {
      body.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: "paragraph", text: body.join("\n") });
  }

  return blocks;
}

function CodeBlock({ code, lang, index }: { code: string; lang: string; index: number }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || "text"}</span>
        <button type="button" onClick={() => void copy()} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      <span className="sr-only">{`code block ${index + 1}`}</span>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = parse(text);

  return (
    <div className="md">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={index} code={block.code} lang={block.lang} index={index} />;
          case "heading": {
            const Tag = (block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4") as
              | "h2"
              | "h3"
              | "h4";
            return <Tag key={index}>{inline(block.text, `h${index}`)}</Tag>;
          }
          case "paragraph":
            return <p key={index}>{inline(block.text, `p${index}`)}</p>;
          case "ul":
            return (
              <ul key={index}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item, `u${index}-${j}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={index}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item, `o${index}-${j}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return <blockquote key={index}>{inline(block.text, `q${index}`)}</blockquote>;
          case "hr":
            return <hr key={index} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
