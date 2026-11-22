import { describe, expect, it } from "vitest";
import type { LargeFilesConfig } from "../../shared/contracts";
import { MAX_ATTACHMENT_BYTES } from "./attachments";
import { effectiveLargeFilesLimits, largeFilesBounds, requestInlineTokens } from "./large-files-limits";

const KB = 1024;
const MB = 1024 * 1024;

const server: LargeFilesConfig = {
  maxUploadBytes: 100 * MB,
  serverThresholdBytes: 512 * KB,
  inlineTokens: 200_000,
  pdfInlineMaxBytes: 7 * MB,
  ttlHours: 72,
  engine: "npm",
};

describe("largeFilesBounds", () => {
  it("runs each threshold from its floor up to what the server allows", () => {
    expect(largeFilesBounds(server)).toEqual({
      serverThresholdKb: { min: 1, max: MAX_ATTACHMENT_BYTES / KB, server: 512 },
      pdfInlineMaxMb: { min: 0, max: 7, server: 7 },
      inlineTokens: { min: 1_000, max: 200_000, server: 200_000 },
    });
  });

  it("caps the size threshold at the server's upload limit when that is below the browser's", () => {
    expect(largeFilesBounds({ ...server, maxUploadBytes: 5 * MB }).serverThresholdKb.max).toBe(5 * KB);
  });

  it("never puts the token floor above the server's own value", () => {
    expect(largeFilesBounds({ ...server, inlineTokens: 500 }).inlineTokens).toEqual({ min: 500, max: 500, server: 500 });
  });
});

describe("effectiveLargeFilesLimits", () => {
  it("uses the server's limits when the user set none", () => {
    expect(effectiveLargeFilesLimits(server, undefined)).toBe(server);
    expect(effectiveLargeFilesLimits(server, {})).toEqual(server);
    expect(effectiveLargeFilesLimits(server, { serverThresholdKb: null, pdfInlineMaxMb: null, inlineTokens: null })).toEqual(server);
    expect(effectiveLargeFilesLimits(server, { inlineTokens: Number.NaN })).toEqual(server);
  });

  it("puts each threshold the user set in place of the server's, leaving the others", () => {
    expect(effectiveLargeFilesLimits(server, { serverThresholdKb: 4096 })).toEqual({ ...server, serverThresholdBytes: 4 * MB });
    expect(effectiveLargeFilesLimits(server, { pdfInlineMaxMb: 3.5 })).toEqual({ ...server, pdfInlineMaxBytes: 3.5 * MB });
    expect(effectiveLargeFilesLimits(server, { inlineTokens: 50_000 })).toEqual({ ...server, inlineTokens: 50_000 });
  });

  it("clamps the size threshold for text, DOCX and PPTX", () => {
    expect(effectiveLargeFilesLimits(server, { serverThresholdKb: 1_000_000 }).serverThresholdBytes).toBe(MAX_ATTACHMENT_BYTES);
    expect(effectiveLargeFilesLimits({ ...server, maxUploadBytes: 2 * MB }, { serverThresholdKb: 4096 }).serverThresholdBytes).toBe(2 * MB);
    expect(effectiveLargeFilesLimits(server, { serverThresholdKb: 0 }).serverThresholdBytes).toBe(KB);
  });

  it("clamps the PDF size to the server's own value and to zero", () => {
    expect(effectiveLargeFilesLimits(server, { pdfInlineMaxMb: 50 }).pdfInlineMaxBytes).toBe(7 * MB);
    expect(effectiveLargeFilesLimits(server, { pdfInlineMaxMb: 0 }).pdfInlineMaxBytes).toBe(0);
    expect(effectiveLargeFilesLimits(server, { pdfInlineMaxMb: -3 }).pdfInlineMaxBytes).toBe(0);
  });

  it("clamps the token threshold between the floor and the server's value", () => {
    expect(effectiveLargeFilesLimits(server, { inlineTokens: 10 }).inlineTokens).toBe(1_000);
    expect(effectiveLargeFilesLimits(server, { inlineTokens: 1_000_000 }).inlineTokens).toBe(200_000);
  });
});

describe("requestInlineTokens", () => {
  it("sends the user's token threshold with npm when it is below the server's", () => {
    expect(requestInlineTokens(server, { inlineTokens: 50_000 })).toBe(50_000);
    expect(requestInlineTokens(server, { inlineTokens: 10 })).toBe(1_000);
  });

  it("sends nothing when the server's value applies", () => {
    expect(requestInlineTokens(server, undefined)).toBeUndefined();
    expect(requestInlineTokens(server, { inlineTokens: null })).toBeUndefined();
    expect(requestInlineTokens(server, { serverThresholdKb: 100 })).toBeUndefined();
    expect(requestInlineTokens(server, { inlineTokens: 200_000 })).toBeUndefined();
    expect(requestInlineTokens(server, { inlineTokens: 500_000 })).toBeUndefined();
  });

  it("sends nothing to an engine that cannot use it, or without the server's limits", () => {
    expect(requestInlineTokens({ ...server, engine: "original" }, { inlineTokens: 50_000 })).toBeUndefined();
    expect(requestInlineTokens({ ...server, engine: undefined }, { inlineTokens: 50_000 })).toBeUndefined();
    expect(requestInlineTokens(undefined, { inlineTokens: 50_000 })).toBeUndefined();
  });
});
