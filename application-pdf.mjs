import { readFileSync, writeFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

function nonBlank(page) {
  const contents = page.node.Contents();
  if (!contents) return false;
  return Array.isArray(contents.asArray?.()) ? contents.asArray().length > 0 : true;
}

export async function mergeApplicationPdfs({ cvPath, coverLetterPath, outputPath, order = 'cv_then_cover' }) {
  if (!['cv_then_cover', 'cover_then_cv'].includes(order)) throw new Error('Unsupported combined-document order');
  const cv = await PDFDocument.load(readFileSync(cvPath));
  const cover = await PDFDocument.load(readFileSync(coverLetterPath));
  if (!cv.getPageCount() || !cover.getPageCount()) throw new Error('Combined-document sources must each contain at least one page');
  if (![...cv.getPages(), ...cover.getPages()].every(nonBlank)) throw new Error('Combined-document source contains a blank page');
  const output = await PDFDocument.create();
  const sources = order === 'cv_then_cover' ? [cv, cover] : [cover, cv];
  for (const source of sources) {
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach((page) => output.addPage(page));
  }
  const expectedPages = cv.getPageCount() + cover.getPageCount();
  if (output.getPageCount() !== expectedPages) throw new Error('Combined document did not preserve every source page exactly once');
  writeFileSync(outputPath, await output.save({ useObjectStreams: false }));
  const verified = await PDFDocument.load(readFileSync(outputPath));
  if (verified.getPageCount() !== expectedPages || !verified.getPages().every(nonBlank)) throw new Error('Combined document page verification failed');
  return { pageCount: expectedPages, cvPages: cv.getPageCount(), coverLetterPages: cover.getPageCount(), order };
}
