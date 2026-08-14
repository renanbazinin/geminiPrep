import { Check, Copy } from "lucide-react";
import { Children, isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
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

export function MarkdownMessage({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        pre: CodePre,
        a: ({ href, children: linkChildren }) => (
          <a href={href} target="_blank" rel="noreferrer">{linkChildren}</a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
