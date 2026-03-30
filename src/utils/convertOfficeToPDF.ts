import { exec } from "child_process";
import path from "path";

const officeMimeTypes = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.ms-powerpoint" // .ppt
];

export const isOfficeFile = (mime: string) => officeMimeTypes.includes(mime);

export const convertToPDF = (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(filePath);
    exec(`soffice --headless --convert-to pdf --outdir "${dir}" "${filePath}"`, (err, _stdout, stderr) => {
      if (err) return reject(err);
      const pdfPath = path.join(dir, path.basename(filePath, path.extname(filePath)) + ".pdf");
      resolve(pdfPath);
    });
  });
};
