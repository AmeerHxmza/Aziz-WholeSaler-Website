import { jsPDF } from 'jspdf';
import { formatMoney, formatQuantity } from './calculations';

export type ReceiptPdfDocument = {
  kind: 'SALE' | 'RETURN';
  number: string;
  date: string;
  reference?: string;
  totalLabel: string;
  total: number;
  notes?: string;
  items: {
    name: string;
    unit: string;
    quantity: number;
    rate: number;
    amount: number;
    note?: string;
  }[];
};

export type ReceiptPdfSettings = {
  business_name: string;
  receipt_footer: string;
};

type TextOp = {
  value: string[];
  x: number;
  y: number;
  size: number;
  bold: boolean;
  align: 'left' | 'center' | 'right';
};
type LineOp = { x1: number; y1: number; x2: number; y2: number; dashed?: boolean; width?: number };
type DrawOp = TextOp | LineOp;

const PAPER_WIDTH = 80;
const CONTENT_LEFT = 5;
const CONTENT_WIDTH = 70;
const ROW_COLUMNS = [22, 12, 16, 20] as const;
const FEED_ALLOWANCE = 8;
const mmPerPoint = 25.4 / 72;

function isLine(op: DrawOp): op is LineOp {
  return 'x1' in op;
}

export function createReceiptPdf(document: ReceiptPdfDocument, settings: ReceiptPdfSettings): Blob {
  const measuring = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [PAPER_WIDTH, 300], compress: true });
  const operations: DrawOp[] = [];
  let y = 4;

  const addText = (
    raw: string,
    x: number,
    maxWidth: number,
    size: number,
    bold = false,
    align: TextOp['align'] = 'left'
  ) => {
    const value = String(raw ?? '');
    measuring.setFont('helvetica', bold ? 'bold' : 'normal');
    measuring.setFontSize(size);
    const wrapped = measuring.splitTextToSize(value, maxWidth) as string[];
    const lines = wrapped.length ? wrapped : [''];
    operations.push({ value: lines, x, y, size, bold, align });
    y += Math.max(size * mmPerPoint * 1.18, 2.6) * lines.length;
  };

  const addRule = (gapBefore = 1.5, gapAfter = 1.5, dashed = false, width = 0.15) => {
    y += gapBefore;
    operations.push({ x1: CONTENT_LEFT, y1: y, x2: CONTENT_LEFT + CONTENT_WIDTH, y2: y, dashed, width });
    y += gapAfter;
  };

  addText(settings.business_name || 'Aziz & Son Wholesaler', CONTENT_LEFT, CONTENT_WIDTH, 11, true, 'center');
  addText(document.kind === 'RETURN' ? 'RETURN BILL' : 'SALE BILL', CONTENT_LEFT, CONTENT_WIDTH, 9, true, 'center');
  y += 1.2;
  addText(`Bill: ${document.number}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2);
  addText(`Date: ${document.date}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2);
  if (document.reference) addText(`Original: ${document.reference}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2);

  addRule(1.4, 1.2, true);
  const starts = [CONTENT_LEFT, CONTENT_LEFT + ROW_COLUMNS[0], CONTENT_LEFT + ROW_COLUMNS[0] + ROW_COLUMNS[1], CONTENT_LEFT + ROW_COLUMNS[0] + ROW_COLUMNS[1] + ROW_COLUMNS[2]];
  const headers = ['Item', 'Qty', 'Rate', 'Amount'];
  headers.forEach((header, index) => {
    measuring.setFont('helvetica', 'bold');
    measuring.setFontSize(7.2);
    const headerWidth = ROW_COLUMNS[index];
    const align: TextOp['align'] = index === 0 ? 'left' : 'right';
    operations.push({ value: [header], x: align === 'right' ? starts[index] + headerWidth - 0.7 : starts[index] + 0.7, y, size: 7.2, bold: true, align });
  });
  y += 3.5;
  addRule(0, 0.6, false, 0.2);

  for (const item of document.items) {
    const cells = [
      { value: item.name, width: ROW_COLUMNS[0] - 1.2, size: 8.2, align: 'left' as const },
      { value: `${formatQuantity(item.quantity)} ${item.unit}`, width: ROW_COLUMNS[1] - 1, size: 7.1, align: 'right' as const },
      { value: formatQuantity(item.rate), width: ROW_COLUMNS[2] - 1, size: 7.1, align: 'right' as const },
      { value: formatQuantity(item.amount), width: ROW_COLUMNS[3] - 1, size: 7.1, align: 'right' as const }
    ];
    const startY = y;
    let rowHeight = 0;
    for (let index = 0; index < cells.length; index++) {
      const cell = cells[index];
      measuring.setFont('helvetica', index === 0 ? 'bold' : 'normal');
      measuring.setFontSize(cell.size);
      const lines = measuring.splitTextToSize(cell.value, cell.width) as string[];
      const lineHeight = Math.max(cell.size * mmPerPoint * 1.18, 2.5);
      rowHeight = Math.max(rowHeight, lineHeight * Math.max(lines.length, 1));
      operations.push({
        value: lines.length ? lines : [''],
        x: cell.align === 'right' ? starts[index] + ROW_COLUMNS[index] - 0.6 : starts[index] + 0.6,
        y: startY,
        size: cell.size,
        bold: index === 0,
        align: cell.align
      });
    }
    if (item.note) {
      measuring.setFont('helvetica', 'normal');
      measuring.setFontSize(7);
      const noteLines = measuring.splitTextToSize(item.note, CONTENT_WIDTH) as string[];
      operations.push({ value: noteLines, x: CONTENT_LEFT + 0.6, y: startY + rowHeight, size: 7, bold: false, align: 'left' });
      rowHeight += Math.max(7 * mmPerPoint * 1.18, 2.5) * noteLines.length;
    }
    y = startY + rowHeight + 1.2;
    operations.push({ x1: CONTENT_LEFT, y1: y - 0.6, x2: CONTENT_LEFT + CONTENT_WIDTH, y2: y - 0.6, dashed: true, width: 0.1 });
  }

  y += 0.5;
  operations.push({ x1: CONTENT_LEFT, y1: y, x2: CONTENT_LEFT + CONTENT_WIDTH, y2: y, width: 0.55 });
  y += 1.4;
  const totalText = formatMoney(document.total);
  measuring.setFont('helvetica', 'bold');
  measuring.setFontSize(9.4);
  const totalWidth = measuring.getTextWidth(totalText);
  addText(document.totalLabel.replace(/\s*\(Rs\.\)/g, ''), CONTENT_LEFT + 0.6, CONTENT_WIDTH - totalWidth - 2, 9.4, true);
  const totalY = y - Math.max(9.4 * mmPerPoint * 1.18, 2.6);
  operations.push({ value: [totalText], x: CONTENT_LEFT + CONTENT_WIDTH - 0.6, y: totalY, size: 9.4, bold: true, align: 'right' });
  y += 0.8;
  operations.push({ x1: CONTENT_LEFT, y1: y, x2: CONTENT_LEFT + CONTENT_WIDTH, y2: y, width: 0.55 });
  y += 1.4;

  if (document.kind === 'RETURN' && document.notes) addText(document.notes, CONTENT_LEFT, CONTENT_WIDTH, 7.6);
  addText(settings.receipt_footer || 'Thank you for your business!', CONTENT_LEFT, CONTENT_WIDTH, 7.8, false, 'center');

  const pageHeight = Math.ceil(y + 2.5 + FEED_ALLOWANCE);
  const orientation = pageHeight < PAPER_WIDTH ? 'landscape' : 'portrait';
  const pdf = new jsPDF({ orientation, unit: 'mm', format: [PAPER_WIDTH, pageHeight], compress: true, putOnlyUsedFonts: true });
  for (const op of operations) {
    if (isLine(op)) {
      pdf.setLineWidth(op.width || 0.15);
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineDashPattern(op.dashed ? [0.7, 0.6] : [], 0);
      pdf.line(op.x1, op.y1, op.x2, op.y2);
      continue;
    }
    pdf.setFont('helvetica', op.bold ? 'bold' : 'normal');
    pdf.setFontSize(op.size);
    pdf.setTextColor(0, 0, 0);
    pdf.text(op.value, op.x, op.y, { align: op.align, lineHeightFactor: 1.18 });
  }
  pdf.setProperties({ title: document.number, subject: 'Thermal receipt' });
  return pdf.output('blob');
}
