import type { ChatGeneratedImage, ChatRequestFilePart, ChatStreamImageData } from "../../shared/contracts";
import { blobToBase64, deleteStoredPayloads, loadInlineBlob, storeInlineBlob } from "./attachments";
import { createId } from "./storage";

function extensionFor(mimeType: ChatGeneratedImage["mimeType"]): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

function base64ToBlob(data: string, mimeType: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

export async function storeGeneratedImage(image: ChatStreamImageData): Promise<ChatGeneratedImage> {
  const id = createId();
  const storageKey = `generated-image:${id}`;
  await storeInlineBlob(storageKey, base64ToBlob(image.data, image.mimeType));
  return { id, storageKey, mimeType: image.mimeType };
}

export async function generatedImageToRequestPart(image: ChatGeneratedImage): Promise<ChatRequestFilePart> {
  const blob = await loadInlineBlob(image.storageKey);
  if (!blob) throw new Error("A generated image is missing from this browser's local file storage.");
  return {
    kind: "inlineData",
    name: `generated-${image.id}.${extensionFor(image.mimeType)}`,
    mimeType: image.mimeType,
    data: await blobToBase64(blob),
  };
}

export async function generatedImageObjectUrl(image: ChatGeneratedImage): Promise<string | null> {
  const blob = await loadInlineBlob(image.storageKey);
  return blob ? URL.createObjectURL(blob) : null;
}

export async function deleteGeneratedImages(images: ChatGeneratedImage[]): Promise<void> {
  await deleteStoredPayloads(images.map((image) => image.storageKey));
}

export function generatedImageFilename(image: ChatGeneratedImage): string {
  return `gemini-image-${image.id.slice(0, 8)}.${extensionFor(image.mimeType)}`;
}
