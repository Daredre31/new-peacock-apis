import PDFDocument from 'pdfkit';

export type Cell = string | number | null;
export interface TableData { title: string; subtitle: string; columns: string[]; rows: Cell[][] }

// A cell starting with one of these could run as a formula when opened in a spreadsheet.
const FORMULA = /^[=+\-@\t\r]/;

function csvCell(value: Cell): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = value.replace(/\r?\n|\r/g, ' ');
  if (FORMULA.test(text)) text = `'${text}`;
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 with a byte-order mark, so Excel reads accents and non-English names correctly. */
export function toCsv(table: TableData): string {
  const lines = [table.columns, ...table.rows].map((row) => row.map((c) => csvCell(c)).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const fit = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);

export function renderTablePdf(table: TableData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = table.columns.length > 6;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, info: { Title: table.title } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 36;
    const width = doc.page.width - 72;
    const colWidth = width / Math.max(1, table.columns.length);
    const maxChars = Math.max(4, Math.floor(colWidth / 4.6));
    const rowHeight = 16;

    const drawRow = (cells: Cell[], y: number, bold: boolean): void => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
      cells.forEach((cell, i) => {
        doc.text(fit(cell === null ? '' : String(cell), maxChars), left + i * colWidth + 2, y + 4, { width: colWidth - 4, lineBreak: false });
      });
      doc.moveTo(left, y + rowHeight).lineTo(left + width, y + rowHeight).strokeColor('#CCCCCC').lineWidth(0.4).stroke();
    };

    doc.font('Helvetica-Bold').fontSize(14).text(table.title, left, 36);
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(table.subtitle, left, 56).fillColor('black');

    let y = 78;
    drawRow(table.columns, y, true);
    y += rowHeight;
    for (const row of table.rows) {
      if (y + rowHeight > doc.page.height - 48) {
        doc.addPage();
        y = 36;
        drawRow(table.columns, y, true);
        y += rowHeight;
      }
      drawRow(row, y, false);
      y += rowHeight;
    }
    doc.end();
  });
}