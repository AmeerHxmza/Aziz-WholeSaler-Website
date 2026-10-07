import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptPdf, type ReceiptPdfDocument } from '../src/lib/receipt-pdf';

const settings = {
  business_name: 'Aziz & Son Wholesaler',
  receipt_footer: 'Thank you for your business!'
};

const sample = {
  kind: 'SALE' as const,
  number: 'INV-2026-000001',
  date: '2026-10-06',
  totalLabel: 'TOTAL',
  total: 25000,
  items: [{ name: 'Lemon Biscuit', unit: 'Corton', quantity: 100, rate: 250, amount: 25000 }]
};

async function pdfText(document: ReceiptPdfDocument) {
  const blob = createReceiptPdf(document, settings);
  return Buffer.from(await blob.arrayBuffer()).toString('latin1');
}

test('receipt PDF is one custom roll page exactly 80 mm wide', async () => {
  const source = await pdfText(sample);
  assert.equal((source.match(/\/Type \/Page\b/g) || []).length, 1);
  const mediaBox = source.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(mediaBox, 'PDF MediaBox missing');
  assert.ok(Math.abs(Number(mediaBox[1]) - (80 / 25.4) * 72) < 0.1);
  assert.ok(Number(mediaBox[2]) > 0);
});

test('long names and return notes remain a single variable-height roll page', async () => {
  const longReceipt = {
    ...sample,
    kind: 'RETURN' as const,
    reference: 'INV-2026-000001',
    totalLabel: 'REFUND',
    notes: 'Damaged / not added to stock',
    items: Array.from({ length: 30 }, (_, index) => ({
      name: `Long wholesale product description ${index + 1} with family packaging`,
      unit: 'Carton',
      quantity: 1.25,
      rate: 12345.67,
      amount: 15432.09,
      note: index === 0 ? 'Damaged / not added to stock' : undefined
    }))
  };
  const source = await pdfText(longReceipt);
  assert.equal((source.match(/\/Type \/Page\b/g) || []).length, 1);
  const mediaBox = source.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
  assert.ok(mediaBox, 'PDF MediaBox missing');
  assert.ok(Math.abs(Number(mediaBox[1]) - (80 / 25.4) * 72) < 0.1);
  assert.ok(Number(mediaBox[2]) > 297, 'Long thermal receipts should extend beyond A4 height');
});
