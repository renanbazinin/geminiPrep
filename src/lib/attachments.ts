import type { ChatAttachment, ChatAttachmentKind, ChatRequestFilePart } from "../../shared/contracts";
import { createId } from "./storage";

const DATABASE_NAME = "gemini-prep-files-v1";
const STORE_NAME = "attachments";
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 1_000_000;

export const ATTACHMENT_ACCEPT = [
  ".pdf", ".md", ".markdown", ".json", ".txt", ".csv", ".xml", ".yaml", ".yml",
  ".docx", ".pptx",
].join(",");

type StoredAttachmentPayload =
  | { kind: "text"; text: string }
  | { kind: "inlineData"; blob: Blob };

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open local attachment storage."));
    });
  }
  return databasePromise;
}

async function storePayload(key: string, payload: StoredAttachmentPayload): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(payload, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the attachment locally."));
  });
}

async function loadPayload(key: string): Promise<StoredAttachmentPayload | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as StoredAttachmentPayload | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read the attachment from local storage."));
  });
}

export async function deleteAttachmentPayloads(attachments: ChatAttachment[]): Promise<void> {
  if (attachments.length === 0) return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    for (const attachment of attachments) transaction.objectStore(STORE_NAME).delete(attachment.storageKey);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not remove local attachments."));
  });
}

function extension(name: string): string {
  return name.toLowerCase().split(".").at(-1) ?? "";
}

export function attachmentKind(file: Pick<File, "name" | "type">): ChatAttachmentKind | null {
  const ext = extension(file.name);
  if (file.type === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (ext === "pptx" || file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (["md", "markdown", "json", "txt", "csv", "xml", "yaml", "yml"].includes(ext)) return "text";
  if (file.type.startsWith("text/") || file.type === "application/json" || file.type === "application/xml") return "text";
  return null;
}

function xmlText(xml: string, paragraphTag: string, textTag: string): string {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The Office document contains invalid XML.");
  const paragraphs = Array.from(document.getElementsByTagName(paragraphTag));
  if (paragraphs.length === 0) {
    return Array.from(document.getElementsByTagName(textTag))
      .map((node) => node.textContent ?? "")
      .join(" ")
      .trim();
  }
  return paragraphs
    .map((paragraph) => Array.from(paragraph.getElementsByTagName(textTag))
      .map((node) => node.textContent ?? "")
      .join(""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(buffer);
  const names = Object.keys(archive.files)
    .filter((name) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name))
    .sort((left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right));
  if (!names.includes("word/document.xml")) throw new Error("This DOCX does not contain word/document.xml.");
  const sections: string[] = [];
  for (const name of names) {
    const xml = await archive.file(name)?.async("text");
    if (!xml) continue;
    const text = xmlText(xml, "w:p", "w:t");
    if (text) sections.push(text);
  }
  return sections.join("\n\n").trim();
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

export async function extractPptxText(buffer: ArrayBuffer): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const archive = await JSZip.loadAsync(buffer);
  const names = Object.keys(archive.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
  if (names.length === 0) throw new Error("This PPTX does not contain any slides.");
  const slides: string[] = [];
  for (const name of names) {
    const xml = await archive.file(name)?.async("text");
    if (!xml) continue;
    const text = xmlText(xml, "a:p", "a:t");
    slides.push(`## Slide ${slideNumber(name)}\n${text || "[No text on this slide]"}`);
  }
  return slides.join("\n\n");
}

function ensureExtractedSize(text: string, name: string): string {
  if (!text.trim()) throw new Error(`${name} did not contain extractable text.`);
  if (text.length > MAX_EXTRACTED_CHARACTERS) {
    throw new Error(`${name} contains more than ${MAX_EXTRACTED_CHARACTERS.toLocaleString()} extracted characters.`);
  }
  return text;
}

export async function processAttachment(file: File): Promise<ChatAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is larger than the local ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
  }
  const kind = attachmentKind(file);
  if (!kind) throw new Error(`${file.name} is not a supported file type.`);
  const id = createId();
  const storageKey = `attachment:${id}`;
  let extractedCharacters: number | undefined;
  if (kind === "pdf") {
    await storePayload(storageKey, { kind: "inlineData", blob: file });
  } else {
    let text: string;
    if (kind === "docx") text = await extractDocxText(await file.arrayBuffer());
    else if (kind === "pptx") text = await extractPptxText(await file.arrayBuffer());
    else text = await file.text();
    text = ensureExtractedSize(text, file.name);
    extractedCharacters = text.length;
    await storePayload(storageKey, { kind: "text", text });
  }
  return {
    id,
    storageKey,
    name: file.name,
    mimeType: kind === "pdf" ? "application/pdf" : file.type || "text/plain",
    size: file.size,
    kind,
    ...(extractedCharacters === undefined ? {} : { extractedCharacters }),
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

export async function attachmentToRequestPart(attachment: ChatAttachment): Promise<ChatRequestFilePart> {
  const payload = await loadPayload(attachment.storageKey);
  if (!payload) throw new Error(`${attachment.name} is missing from this browser's local file storage.`);
  if (payload.kind === "text") {
    return { kind: "text", name: attachment.name, mimeType: attachment.mimeType, text: payload.text };
  }
  return {
    kind: "inlineData",
    name: attachment.name,
    mimeType: "application/pdf",
    data: await blobToBase64(payload.blob),
  };
}
