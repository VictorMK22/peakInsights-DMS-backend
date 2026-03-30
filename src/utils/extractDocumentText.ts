import fs from "fs";
import mammoth from "mammoth";
const pdf = require("pdf-parse");

export const extractDocumentText = async (
  input: Buffer | string,
  fileType: string
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