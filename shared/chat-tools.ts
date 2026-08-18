import type { ChatImageMimeType, ChatStreamRequest, ChatToolId } from "./contracts.js";

export const IMAGE_MODEL_ID = "gemini-3.1-flash-image";
export const IMAGE_MODEL_REGION = "global";

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export const GRAPH_SYSTEM_PROMPT = `You generate diagrams for on-page display with Mermaid.js.
Reply with a short caption if useful, then exactly one fenced mermaid code block:

\`\`\`mermaid
...
\`\`\`

Use flowchart, sequence, class, er, state, or gantt as appropriate.
Do not use HTML. Prefer LR for wide graphs. Keep node labels short.`;

export type ChatHandoffTool = {
  name: string;
  kind: "handoff";
  toolId: ChatToolId;
  argumentKey: "prompt" | "request";
  declaration: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: "string"; description: string }>;
      required: string[];
    };
  };
};

export const CHAT_HANDOFF_TOOLS: ChatHandoffTool[] = [
  {
    name: "generate_image",
    kind: "handoff",
    toolId: "image",
    argumentKey: "prompt",
    declaration: {
      name: "generate_image",
      description: "Generate or edit an image from a text description. Use when the user asks to draw, generate, create, imagine, or modify a picture.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Full image prompt, including any requested edits to a previous image in the conversation.",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    name: "generate_graph",
    kind: "handoff",
    toolId: "graph",
    argumentKey: "request",
    declaration: {
      name: "generate_graph",
      description: "Create a Mermaid diagram such as a flowchart, sequence diagram, architecture map, or ER chart. Use when the user asks for a graph, diagram, flowchart, or visual structure.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "What the diagram should show.",
          },
        },
        required: ["request"],
      },
    },
  },
];

export function chatFunctionDeclarations(): ChatHandoffTool["declaration"][] {
  return CHAT_HANDOFF_TOOLS.map((tool) => tool.declaration);
}

export function handoffForFunctionCall(name: string): ChatHandoffTool | undefined {
  return CHAT_HANDOFF_TOOLS.find((tool) => tool.name === name);
}

export function specialistRequestFromHandoff(
  request: ChatStreamRequest,
  handoff: ChatHandoffTool,
  args: Record<string, unknown>,
): ChatStreamRequest {
  const raw = args[handoff.argumentKey];
  const rewritten = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  const messages = request.messages.map((message, index) => (
    index === request.messages.length - 1 && rewritten
      ? { ...message, content: rewritten }
      : message
  ));
  if (handoff.toolId === "image") {
    return {
      provider: request.provider,
      model: IMAGE_MODEL_ID,
      ...(request.provider === "vertex" ? { region: IMAGE_MODEL_REGION } : {}),
      ...(request.systemInstruction ? { systemInstruction: request.systemInstruction } : {}),
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      tool: "image",
      messages,
    };
  }
  const { cachedContent: _cachedContent, ...rest } = request;
  return {
    ...rest,
    tool: "graph",
    messages,
  };
}

export function isChatToolId(value: unknown): value is ChatToolId {
  return value === "image" || value === "graph";
}

export function normalizeImageMimeType(value: string): ChatImageMimeType | null {
  const mime = value.trim().toLowerCase() === "image/jpg" ? "image/jpeg" : value.trim().toLowerCase();
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mime) ? mime as ChatImageMimeType : null;
}

export function mergeGraphSystemInstruction(userInstruction?: string): string {
  const user = userInstruction?.trim() ?? "";
  return user ? `${user}\n\n${GRAPH_SYSTEM_PROMPT}` : GRAPH_SYSTEM_PROMPT;
}

export function resolvedChatSystemInstruction(request: {
  tool?: ChatToolId;
  systemInstruction?: string;
}): string {
  if (request.tool === "graph") return mergeGraphSystemInstruction(request.systemInstruction);
  return request.systemInstruction?.trim() ?? "";
}
