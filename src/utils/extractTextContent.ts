import path from "path";

/**
 * Best-effort text extraction at upload time, so the in-browser
 * content editor (patchDocumentContent) has something real to work
 * with right away instead of starting empty. Never throws — a failed
 * extraction just means contentText stays empty, it doesn't block
 * the upload itself.
 *
 * Covers: .txt/.md/.csv (plain text), .rtf (control-code stripped),
 * .docx (mammoth), .xlsx/.xls (xlsx — handles both formats), .pptx
 * (slide text via JSZip, since .pptx is just a zip of XML).
 * Deliberately NOT covered: PDFs (excluded by design), and legacy
 * binary .doc/.ppt (pre-XML Office formats — would need something
 * like LibreOffice/antiword to read at all, not worth the dependency
 * weight for a best-effort feature).
 */
// MongoDB documents max out at 16 MB, and the BSON serializer's buffer is
// 17 MiB — a spreadsheet whose sheets were "formatted" down to the last row
// can flatten to tens of MB of commas, which is what produced
// `The value of "offset" is out of range ... 17825792` and failed the upload.
// Extracted text is only for search / the editor, so it is capped well below.
export const MAX_CONTENT_TEXT_CHARS = 2_000_000;

export const capContentText = (text: string | undefined): string | undefined =>
  text && text.length > MAX_CONTENT_TEXT_CHARS
    ? text.slice(0, MAX_CONTENT_TEXT_CHARS)
    : text;

export const extractTextContent = async (
  fileBuffer: Buffer,
  fileType: string,
  originalName: string,
): Promise<string | undefined> => {
  const ext = path.extname(originalName).toLowerCase();

  try {
    // Plain text formats — mimetype detection for .md/.csv is
    // inconsistent across browsers/OSes, so extension is checked too.
    if (
      fileType === "text/plain" ||
      fileType === "text/markdown" ||
      fileType === "text/csv" ||
      [".txt", ".md", ".csv"].includes(ext)
    ) {
      return capContentText(fileBuffer.toString("utf-8"));
    }

    // RTF — strip control codes/groups for a rough plain-text read.
    // Not a full RTF parser, but good enough to make the text searchable/editable.
    if (
      fileType === "application/rtf" ||
      fileType === "text/rtf" ||
      ext === ".rtf"
    ) {
      const raw = fileBuffer.toString("utf-8");
      return raw
        .replace(/\\par[d]?/g, "\n")
        .replace(/\{\\[^{}]*\}/g, "")
        .replace(/\\[a-zA-Z]+-?\d*/g, "")
        .replace(/[{}]/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    // .docx
    if (
      fileType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      ext === ".docx"
    ) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return capContentText(result.value);
    }

    // .xlsx / .xls — xlsx (SheetJS) reads both formats transparently.
    // Every sheet's cells are flattened into rows of text.
    if (
      fileType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      fileType === "application/vnd.ms-excel" ||
      [".xlsx", ".xls"].includes(ext)
    ) {
      const XLSX = await import("xlsx");
      // sheetRows bounds how far SheetJS reads down a sheet, so a sheet
      // declared as A1:XFD1048576 can't blow up memory/time.
      const workbook = XLSX.read(fileBuffer, {
        type: "buffer",
        sheetRows: 50_000,
      });
      const parts: string[] = [];
      let total = 0;
      for (const name of workbook.SheetNames) {
        if (total >= MAX_CONTENT_TEXT_CHARS) break;
        const sheet = workbook.Sheets[name];
        // Don't trust the declared range (!ref): a sheet "formatted" down to
        // the last row/column declares millions of cells, and walking them is
        // slow even when they're all empty. Shrink it to the cells that exist.
        let maxR = -1;
        let maxC = -1;
        for (const key of Object.keys(sheet)) {
          if (key.charCodeAt(0) === 33 /* "!" */) continue;
          const { r, c } = XLSX.utils.decode_cell(key);
          if (r > maxR) maxR = r;
          if (c > maxC) maxC = c;
        }
        if (maxR < 0) continue; // sheet has no cells at all
        sheet["!ref"] = XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: maxR, c: maxC },
        });
        const csv = XLSX.utils
          .sheet_to_csv(sheet, { blankrows: false })
          // drop the trailing-comma padding of rows that are only partly filled
          .replace(/,+(?=\n|$)/g, "")
          .trim();
        const block = `--- ${name} ---\n${csv}`;
        parts.push(block);
        total += block.length;
      }
      return capContentText(parts.join("\n\n"));
    }

    // .pptx — a zip of XML; slide text lives in <a:t> runs inside
    // ppt/slides/slideN.xml.
    if (
      fileType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      ext === ".pptx"
    ) {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(fileBuffer);

      const slideFiles = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => {
          const numA = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
          const numB = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
          return numA - numB;
        });

      const slideTexts = await Promise.all(
        slideFiles.map(async (name, i) => {
          const xml = await zip.files[name].async("string");
          const text = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)]
            .map((m) => m[1])
            .join(" ");
          return `--- Slide ${i + 1} ---\n${text}`;
        }),
      );
      return capContentText(slideTexts.join("\n\n"));
    }
  } catch (err) {
    console.error("extractTextContent failed (non-fatal):", err);
  }
  return undefined;
};

export type IndexKind = "text" | "spreadsheet" | "office" | "none";

/**
 * Which extraction path (if any) a file takes in extractTextContent above.
 * Lets callers decide — from the name and mime type alone — whether a file is
 * worth downloading for indexing at all (a 2 GB video never is).
 *   text         plain text / markdown / csv / rtf — can be read in part
 *   spreadsheet  .xlsx / .xls — whole file in memory, and the heaviest
 *   office       .docx / .pptx — whole file in memory
 *   none         no extractor (PDF by design, images, video, archives…)
 */
export const classifyForIndexing = (
  fileType: string,
  originalName: string,
): IndexKind => {
  const ext = path.extname(originalName).toLowerCase();
  if (
    fileType === "text/plain" ||
    fileType === "text/markdown" ||
    fileType === "text/csv" ||
    fileType === "application/rtf" ||
    fileType === "text/rtf" ||
    [".txt", ".md", ".csv", ".rtf"].includes(ext)
  )
    return "text";
  if (
    fileType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    fileType === "application/vnd.ms-excel" ||
    [".xlsx", ".xls"].includes(ext)
  )
    return "spreadsheet";
  if (
    fileType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    fileType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    [".docx", ".pptx"].includes(ext)
  )
    return "office";
  return "none";
};