import fs from "fs";
import mammoth from "mammoth";

export const extractDocumentText = async (
  input: Buffer | string,
  fileType: string,
): Promise<string> => {
  try {
    // =========================
    // 📄 WORD DOCUMENTS (DOCX)
    // =========================
    if (fileType.includes("word") || fileType.includes("officedocument")) {
      if (Buffer.isBuffer(input)) {
        const result = await mammoth.extractRawText({ buffer: input });
        return result.value;
      }

      if (!fs.existsSync(input)) return "";

      const result = await mammoth.extractRawText({ path: input });
      return result.value;
    }

    // =========================
    // 📕 PDF DOCUMENTS
    // =========================
    if (fileType === "application/pdf") {
      let buffer: Buffer;

      if (Buffer.isBuffer(input)) {
        buffer = input;
      } else {
        if (!fs.existsSync(input)) return "";
        buffer = fs.readFileSync(input);
      }

      // Loaded here, not at the top of the file, and specifically INSIDE
      // this try block. pdf-parse pulls in @napi-rs/canvas, a native
      // binary module that isn't available in Vercel's serverless
      // runtime. A top-level `require` at module load time meant this
      // failure happened the instant this file was imported — which
      // crashed EVERY request through the app (even unrelated ones like
      // /api/auth), since documentController.ts imports this function
      // and app.ts loads every controller at startup. Loading it lazily,
      // right here, means only an actual PDF-upload request ever
      // triggers it, and if it does fail, this function's own try/catch
      // below catches it same as any other extraction error — PDF text
      // extraction is skipped for that one file, nothing else breaks.
      const pdf = require("pdf-parse");
      const data = await pdf(buffer);
      return data.text || "";
    }

    // =========================
    // 📃 TEXT FILES (BONUS)
    // =========================
    if (fileType.includes("text/plain")) {
      if (Buffer.isBuffer(input)) {
        return input.toString("utf-8");
      }

      if (!fs.existsSync(input)) return "";
      return fs.readFileSync(input, "utf-8");
    }

    return "";
  } catch (error) {
    console.error("❌ Extraction failed:", error);
    return "";
  }
};
