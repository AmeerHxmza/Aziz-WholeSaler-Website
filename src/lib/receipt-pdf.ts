import { jsPDF } from 'jspdf';
import { formatMoney, formatQuantity } from './calculations';

export type ReceiptPdfDocument = {
  kind: 'SALE' | 'RETURN';
  number: string;
  date: string;
  reference?: string;
  customerName?: string | null;
  customerPhone?: string | null;
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
const CENTER_X = 40;
const RIGHT_X = CONTENT_LEFT + CONTENT_WIDTH; // 75 mm
const ROW_COLUMNS = [22, 13, 16, 19] as const;
const FEED_ALLOWANCE = 8;
const mmPerPoint = 25.4 / 72;

function isLine(op: DrawOp): op is LineOp {
  return 'x1' in op;
}

export function createReceiptPdf(document: ReceiptPdfDocument, settings: ReceiptPdfSettings): Blob {
  const measuring = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [PAPER_WIDTH, 300], compress: true });
  const operations: DrawOp[] = [];
  let y = 5;

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
    y += Math.max(size * mmPerPoint * 1.22, 2.7) * lines.length;
  };

  const addRule = (gapBefore = 1.5, gapAfter = 1.8, dashed = false, width = 0.15) => {
    y += gapBefore;
    operations.push({ x1: CONTENT_LEFT, y1: y, x2: RIGHT_X, y2: y, dashed, width });
    y += gapAfter;
  };

  // 1. Header (Centered at CENTER_X = 40mm)
  addText(settings.business_name || 'Aziz & Son Wholesaler', CENTER_X, CONTENT_WIDTH, 11, true, 'center');
  y += 0.8;
  addText(document.kind === 'RETURN' ? 'RETURN' : 'SALE', CENTER_X, CONTENT_WIDTH, 11, true, 'center');
  y += 1.5;

  // 2. Metadata (Left aligned at CONTENT_LEFT = 5mm)
  addText(`Bill: ${document.number}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2);
  addText(`Date: ${document.date}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2);
  addText(`Customer: ${document.customerName || 'Walk-in'}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2, true);
  addText(`Mobile: ${document.customerPhone || '—'}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2, Boolean(document.customerPhone));
  if (document.reference) addText(`Original: ${document.reference}`, CONTENT_LEFT, CONTENT_WIDTH, 8.2);

  // 3. Table Header
  addRule(1.5, 1.5, true);
  const starts = [
    CONTENT_LEFT,
    CONTENT_LEFT + ROW_COLUMNS[0],
    CONTENT_LEFT + ROW_COLUMNS[0] + ROW_COLUMNS[1],
    CONTENT_LEFT + ROW_COLUMNS[0] + ROW_COLUMNS[1] + ROW_COLUMNS[2]
  ];
  const headers = ['Item', 'Qty', 'Rate', 'Amount'];
  headers.forEach((header, index) => {
    measuring.setFont('helvetica', 'bold');
    measuring.setFontSize(7.4);
    const align: TextOp['align'] = index === 0 ? 'left' : 'right';
    const xPos = index === 0 ? starts[index] : starts[index] + ROW_COLUMNS[index];
    operations.push({ value: [header], x: xPos, y, size: 7.4, bold: true, align });
  });
  y += 3.4;
  addRule(0.5, 1.8, false, 0.2);

  // 4. Line Items
  for (const item of document.items) {
    const startY = y;
    measuring.setFont('helvetica', 'bold');
    measuring.setFontSize(7.8);
    const nameLines = (measuring.splitTextToSize(item.name, ROW_COLUMNS[0] - 1) as string[]) || [''];
    const nameLineHeight = Math.max(7.8 * mmPerPoint * 1.22, 2.8);

    measuring.setFont('helvetica', 'normal');
    measuring.setFontSize(7.3);
    const qtyText = `${formatQuantity(item.quantity)} ${item.unit}`;
    const rateText = formatQuantity(item.rate);
    const amountText = formatQuantity(item.amount);

    const qtyLines = (measuring.splitTextToSize(qtyText, ROW_COLUMNS[1]) as string[]) || [''];
    const rateLines = (measuring.splitTextToSize(rateText, ROW_COLUMNS[2]) as string[]) || [''];
    const amountLines = (measuring.splitTextToSize(amountText, ROW_COLUMNS[3]) as string[]) || [''];
    const colLineHeight = Math.max(7.3 * mmPerPoint * 1.22, 2.6);

    const mainRowsCount = Math.max(nameLines.length, qtyLines.length, rateLines.length, amountLines.length);
    const mainHeight = Math.max(nameLines.length * nameLineHeight, mainRowsCount * colLineHeight);

    // Push item cells
    operations.push({ value: nameLines, x: starts[0], y: startY, size: 7.8, bold: true, align: 'left' });
    operations.push({ value: qtyLines, x: starts[1] + ROW_COLUMNS[1], y: startY, size: 7.3, bold: false, align: 'right' });
    operations.push({ value: rateLines, x: starts[2] + ROW_COLUMNS[2], y: startY, size: 7.3, bold: false, align: 'right' });
    operations.push({ value: amountLines, x: starts[3] + ROW_COLUMNS[3], y: startY, size: 7.3, bold: false, align: 'right' });

    let itemTotalHeight = mainHeight;
    if (item.note) {
      measuring.setFont('helvetica', 'normal');
      measuring.setFontSize(7);
      const noteLines = (measuring.splitTextToSize(item.note, CONTENT_WIDTH) as string[]) || [''];
      const noteLineHeight = Math.max(7 * mmPerPoint * 1.22, 2.5);
      operations.push({ value: noteLines, x: CONTENT_LEFT, y: startY + itemTotalHeight + 0.8, size: 7, bold: false, align: 'left' });
      itemTotalHeight += noteLines.length * noteLineHeight + 1.2;
    }

    y = startY + itemTotalHeight + 1.2;
    operations.push({ x1: CONTENT_LEFT, y1: y, x2: RIGHT_X, y2: y, dashed: true, width: 0.1 });
    y += 1.6;
  }

  // 5. Total Section
  y += 0.4;
  operations.push({ x1: CONTENT_LEFT, y1: y, x2: RIGHT_X, y2: y, width: 0.4 });
  y += 2.0;

  const totalLabel = document.totalLabel.replace(/\s*\(Rs\.\)/g, '');
  const totalText = formatMoney(document.total);
  operations.push({ value: [totalLabel], x: CONTENT_LEFT, y, size: 9.4, bold: true, align: 'left' });
  operations.push({ value: [totalText], x: RIGHT_X, y, size: 9.4, bold: true, align: 'right' });
  y += 4.2;

  operations.push({ x1: CONTENT_LEFT, y1: y, x2: RIGHT_X, y2: y, width: 0.4 });
  y += 2.2;

  // 6. Notes & Footer
  if (document.kind === 'RETURN' && document.notes) {
    addText(document.notes, CONTENT_LEFT, CONTENT_WIDTH, 7.6);
    y += 1.0;
  }
  addText(settings.receipt_footer || 'Thank you for your business!', CENTER_X, CONTENT_WIDTH, 7.8, false, 'center');

  // 7. Page Geometry & Draw
  const pageHeight = Math.ceil(y + FEED_ALLOWANCE);
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
    pdf.text(op.value, op.x, op.y, { align: op.align, baseline: 'top', lineHeightFactor: 1.22 });
  }

  pdf.setProperties({ title: document.number, subject: 'Thermal receipt' });
  return pdf.output('blob');
}
