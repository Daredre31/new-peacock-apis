import PDFDocument from 'pdfkit';
import type { AttendanceSummary } from './reportCard.repository';

export interface ReportCardData {
  school: string; studentName: string; admissionNo: string; className: string; termName: string; sessionName: string;
  componentHeaders: string[];
  rows: { subject: string; components: (number | null)[]; total: number; grade: string; remark: string }[];
  grandTotal: number; average: number | null; position: number; classSize: number;
  attendance: AttendanceSummary | null; conduct: string | null; remark: string | null; classTeacher: string | null;
  provisional: boolean;
}

const L = 40;
const W = 515;
const fmt = (n: number | null): string => (n === null ? '-' : String(n));

export function renderReportCard(data: ReportCardData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: L, info: { Title: `Report card: ${data.studentName}`, Author: data.school } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).text(data.school, L, 40, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(12).text('TERMINAL REPORT CARD', L, 64, { width: W, align: 'center' });
    if (data.provisional) {
      doc.fillColor('#B00020').fontSize(10).text('PROVISIONAL: THESE RESULTS ARE NOT YET PUBLISHED', L, 82, { width: W, align: 'center' }).fillColor('black');
    }

    const detail = (label: string, value: string, x: number, y: number): void => {
      doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, x, y, { continued: true }).font('Helvetica').text(value);
    };
    detail('Name', data.studentName, L, 106);
    detail('Admission No', data.admissionNo, 330, 106);
    detail('Class', data.className, L, 122);
    detail('Term', `${data.termName}, ${data.sessionName}`, 330, 122);

    // Subject table
    const subjectW = 140, totalW = 40, gradeW = 40, remarkW = 85;
    const componentW = Math.max(30, Math.floor((W - subjectW - totalW - gradeW - remarkW) / Math.max(1, data.componentHeaders.length)));
    const cols = [
      { title: 'Subject', w: subjectW, align: 'left' as const },
      ...data.componentHeaders.map((title) => ({ title, w: componentW, align: 'center' as const })),
      { title: 'Total', w: totalW, align: 'center' as const },
      { title: 'Grade', w: gradeW, align: 'center' as const },
      { title: 'Remark', w: remarkW, align: 'left' as const },
    ];

    const drawRow = (cells: string[], y: number, bold: boolean): void => {
      let x = L;
      cols.forEach((col, i) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).text(cells[i] ?? '', x + 3, y + 4, { width: col.w - 6, align: col.align, lineBreak: false });
        x += col.w;
      });
      doc.moveTo(L, y + 18).lineTo(L + cols.reduce((s, c) => s + c.w, 0), y + 18).strokeColor('#BBBBBB').lineWidth(0.5).stroke();
    };

    let y = 150;
    doc.rect(L, y, cols.reduce((s, c) => s + c.w, 0), 18).fill('#EEEEEE').fillColor('black');
    drawRow(cols.map((c) => c.title), y, true);
    y += 18;
    for (const row of data.rows) {
      if (y > 730) { doc.addPage(); y = 40; drawRow(cols.map((c) => c.title), y, true); y += 18; }
      drawRow([row.subject, ...row.components.map(fmt), String(row.total), row.grade, row.remark], y, false);
      y += 18;
    }

    // Summary
    y += 14;
    if (y > 700) { doc.addPage(); y = 40; }
    detail('Total score', String(data.grandTotal), L, y);
    detail('Average', data.average === null ? '-' : `${data.average}`, 200, y);
    detail('Position', `${data.position} of ${data.classSize}`, 330, y);
    y += 20;
    if (data.attendance) {
      const a = data.attendance;
      detail('Attendance', `${a.present + a.late + a.excused} of ${a.days} days${a.rate === null ? '' : ` (${a.rate}%)`}; absent ${a.absent}`, L, y);
      y += 20;
    }
    detail('Conduct', data.conduct ? data.conduct.replace(/_/g, ' ').toLowerCase() : 'Not yet assessed', L, y);
    y += 20;
    doc.font('Helvetica-Bold').fontSize(10).text('Class teacher\'s remark:', L, y);
    doc.font('Helvetica').fontSize(10).text(data.remark ?? 'None', L, y + 14, { width: W });
    y = Math.max(doc.y + 24, y + 56);
    if (y > 760) { doc.addPage(); y = 60; }
    doc.moveTo(L, y).lineTo(L + 200, y).strokeColor('black').lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(9).text(data.classTeacher ? `Class teacher: ${data.classTeacher}` : 'Class teacher', L, y + 4);

    doc.end();
  });
}