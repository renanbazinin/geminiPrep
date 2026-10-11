// A small, generic Gemini function-calling loop (generateContent, non-streaming).
// It knows nothing about Jira: give it a request body with tools and an executor, and it
// alternates "model asks for tools" → "we run them" → "model continues" until a text answer.

export type ToolCallRecord = { tool: string; args: Record<string, unknown>; ok: boolean; result: unknown };
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** The shared upstream builder targets the streaming endpoint; tool loops need whole responses. */
export function toGenerateContentUrl(streamUrl: string): string {
  const url = streamUrl.replace(":streamGenerateContent?alt=sse", ":generateContent");
  if (url === streamUrl) throw new Error("Unexpected model endpoint format.");
  return url;
}

export async function runToolLoop(options: {
  url: string;
  init: RequestInit;
  body: { contents: unknown[]; [key: string]: unknown };
  execute: ToolExecutor;
  fetchImpl?: typeof fetch;
  maxRounds?: number;
  maxCalls?: number;
}): Promise<{ text: string; calls: ToolCallRecord[] }> {
  const { url, init, body, execute, fetchImpl = fetch, maxRounds = 8, maxCalls = 24 } = options;
  const calls: ToolCallRecord[] = [];
  for (let round = 0; round < maxRounds; round++) {
    const response = await fetchImpl(url, { ...init, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) throw new Error(data?.error?.message ?? `The model returned HTTP ${response.status}. Check model settings.`);
    const content = data.candidates?.[0]?.content;
    if (!content?.parts) throw new Error("The model returned no answer. Try again.");

    const requested = content.parts.filter((part: any) => part.functionCall);
    if (!requested.length) {
      const text = content.parts.filter((p: any) => typeof p.text === "string" && !p.thought).map((p: any) => p.text).join("");
      return { text: text || "(No text answer.)", calls };
    }
    // Send the model's turn back unchanged: Gemini 3 needs its thought signatures and call IDs.
    body.contents.push(content);
    const responses: unknown[] = [];
    for (const part of requested) {
      if (calls.length >= maxCalls) throw new Error("Too many lookups in one message. Try a more specific request.");
      const call = part.functionCall;
      const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
      let record: ToolCallRecord;
      try { record = { tool: String(call.name), args, ok: true, result: await execute(String(call.name), args) }; }
      // Every tool here is a read or a local draft edit, so errors go back to the model to recover from.
      catch (error) { record = { tool: String(call.name), args, ok: false, result: { error: error instanceof Error ? error.message : "Tool failed." } }; }
      calls.push(record);
      responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { result: record.result } } });
    }
    body.contents.push({ role: "user", parts: responses });
  }
  return { text: "I ran out of steps for this message. Ask again, a bit more specifically.", calls };
}
