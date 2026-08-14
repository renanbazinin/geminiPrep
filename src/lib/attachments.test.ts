// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { attachmentKind, extractDocxText, extractPptxText } from "./attachments";

describe("attachment type routing", () => {
  it.each([
    ["guide.md", "text/markdown", "text"],
    ["data.json", "application/json", "text"],
    ["report.pdf", "application/pdf", "pdf"],
    ["brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ])("routes %s", (name, type, expected) => {
    expect(attachmentKind({ name, type })).toBe(expected);
  });

  it("does not pretend legacy binary Word files are readable", () => {
    expect(attachmentKind({ name: "legacy.doc", type: "application/msword" })).toBeNull();
  });
});

describe("Office Open XML text extraction", () => {
  it("strips readable paragraphs from DOCX XML", async () => {
    const archive = new JSZip();
    archive.file("word/document.xml", `<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>Word</w:t></w:r></w:p>
          <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
        </w:body>
      </w:document>`);
    const buffer = await archive.generateAsync({ type: "arraybuffer" });
    expect(await extractDocxText(buffer)).toBe("Hello Word\nSecond paragraph");
  });

  it("extracts PPTX text in numeric slide order", async () => {
    const archive = new JSZip();
    const slide = (text: string) => `<?xml version="1.0"?>
      <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld>
      </p:sld>`;
    archive.file("ppt/slides/slide10.xml", slide("Last"));
    archive.file("ppt/slides/slide2.xml", slide("First"));
    const buffer = await archive.generateAsync({ type: "arraybuffer" });
    expect(await extractPptxText(buffer)).toBe("## Slide 2\nFirst\n\n## Slide 10\nLast");
  });
});
