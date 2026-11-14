import { estimateTokens as packageEstimate } from "llm-large-files";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "./token-estimate.js";

const LOG_LINE = "2026-11-10T14:03:17.482Z ERROR [payments-api] host=prod-pay-01 trace=cb48642de01379d5 PAY-5031 pool exhausted active=4 max=4 waited_ms=1500\n";

const TEXTS: Record<string, string> = {
  empty: "",
  prose: "The quick brown fox jumps over the lazy dog, and nobody in the village was surprised by it. ".repeat(40),
  log: LOG_LINE.repeat(200),
  csv: "id,created_at,amount,currency\n" + Array.from({ length: 300 }, (_, row) => `${10_000 + row},2026-11-10T06:00:${String(row % 60).padStart(2, "0")}Z,${(row * 7.31).toFixed(2)},EUR`).join("\n"),
  json: JSON.stringify({ orderId: "A1B2C3", lineItems: [{ sku: "X-9912", quantity: 3, unitPrice: 19.99 }], isGift: false }, null, 2).repeat(30),
  code: "export function camelCaseName(HTTPServer: string): number {\n\treturn HTTPServer.length * 2;\n}\n".repeat(50),
  hebrew: "זהו טקסט קצר בעברית, עם פסיקים ונקודה בסופו. ".repeat(60),
  mixed: "Ünïcödé — “quotes” → arrows, 漢字とかな, 한국어, Ελληνικά, Кириллица, العربية 😀\n".repeat(40),
  base64: "QWxhZGRpbjpvcGVuIHNlc2FtZQ==".repeat(120),
};

describe("token estimate", () => {
  // The browser decides with this estimate which files to upload, and the server decides with the
  // package's which uploaded files to send in full. A failure here means the two have drifted
  // apart, most likely because a new llm-large-files changed its estimator: copy it to
  // shared/token-estimate.ts.
  it.each(Object.entries(TEXTS))("counts %s as llm-large-files does", (_name, text) => {
    expect(estimateTokens(text)).toBe(packageEstimate(text));
  });

  it("counts a log as far denser than prose of the same length", () => {
    const log = LOG_LINE.repeat(1_000);
    const prose = "a line of a long book\n".repeat(Math.ceil(log.length / 22)).slice(0, log.length);
    expect(log.length / estimateTokens(log)).toBeLessThan(2);
    expect(prose.length / estimateTokens(prose)).toBeGreaterThan(2.4);
  });
});
