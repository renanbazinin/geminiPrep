import { Check, Copy } from "lucide-react";
import mermaid from "mermaid";
import { Children, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

let mermaidConfigured = false;

function ensureMermaid(): void {
  if (mermaidConfigured) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    fontFamily: "Manrope, sans-serif",
  });
  mermaidConfigured = true;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

export function hasMermaidFence(text: string): boolean {
  return /```mermaid\b/i.test(text);
}

function CodePre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const content = nodeText(children).replace(/\n$/, "");
  async function copy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <div className="code-frame">
      <button className="code-copy" onClick={() => void copy()} aria-label="Copy code">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>{Children.toArray(children)}</pre>
    </div>
  );
}

function mermaidSourceFromPre(children: ReactNode): string | null {
  const child = Children.toArray(children)[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null;
  if (!String(child.props.className ?? "").includes("language-mermaid")) return null;
  return nodeText(child.props.children).replace(/\n$/, "");
}

function MermaidBlock({ source }: { source: string }) {
  const reactId = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ensureMermaid();
    const renderId = `mermaid-${reactId}-${Math.random().toString(36).slice(2, 8)}`;
    void mermaid.render(renderId, source).then((result) => {
      if (!cancelled) setSvg(result.svg);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [reactId, source]);

  if (failed) return <CodePre>{source}</CodePre>;
  if (!svg) {
    return (
      <div className="mermaid-frame mermaid-pending" aria-label="Rendering diagram">
        Rendering diagram…
      </div>
    );
  }
  return (
    <div className="mermaid-frame" aria-label="Diagram">
      <div className="mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

export function MarkdownMessage({
  children,
  complete = true,
  wrapAsMermaid = false,
}: {
  children: string;
  complete?: boolean;
  wrapAsMermaid?: boolean;
}) {
  if (wrapAsMermaid && !hasMermaidFence(children)) {
    const source = children.trim();
    if (!source) return null;
    if (!complete) return <CodePre>{source}</CodePre>;
    return <MermaidBlock source={source} />;
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        pre: ({ children: preChildren }) => {
          const mermaidSource = mermaidSourceFromPre(preChildren);
          if (mermaidSource && complete) return <MermaidBlock source={mermaidSource} />;
          return <CodePre>{preChildren}</CodePre>;
        },
        a: ({ href, children: linkChildren }) => (
          <a href={href} target="_blank" rel="noreferrer">{linkChildren}</a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
