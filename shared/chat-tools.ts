import type { ChatImageMimeType, ChatPresentationCard, ChatStreamRequest, ChatToolId } from "./contracts.js";

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
  {
    name: "make_presentation",
    kind: "handoff",
    toolId: "presentation",
    argumentKey: "request",
    declaration: {
      name: "make_presentation",
      description: "Plan, create or change a PowerPoint presentation (a slide deck, a pptx file). Use when the user asks for a presentation, a deck or slides, approves or changes a presentation plan, or wants to change a presentation made earlier in this conversation.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "What the user wants done, in their words.",
          },
        },
        required: ["request"],
      },
    },
  },
];

/** How a plan or deck from an earlier turn is told to the model again: a note after that turn's text. */
export const PRESENTATION_NOTE_PREFIX = "[presentation tool result]";

export function presentationNote(card: Pick<ChatPresentationCard, "context">): string {
  return `${PRESENTATION_NOTE_PREFIX} ${card.context}`;
}

/** A message's text with the notes of the plans and decks made in it, as sent back on later turns. */
export function contentWithPresentationNotes(content: string, cards: ChatPresentationCard[] | undefined): string {
  if (!cards?.length) return content;
  return [content.trim(), ...cards.map(presentationNote)].filter(Boolean).join("\n\n");
}

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
  // The presentation tools read the conversation as the user wrote it, so nothing is rewritten.
  if (handoff.toolId === "presentation") return { ...rest, tool: "presentation" };
  return {
    ...rest,
    tool: "graph",
    messages,
  };
}

export function isChatToolId(value: unknown): value is ChatToolId {
  return value === "image" || value === "graph" || value === "presentation";
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
