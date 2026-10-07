export type ThermalSaleReceipt = {
  invoiceNumber: string;
  date: string;
  customerName?: string | null;
  customerPhone?: string | null;
  items: {
    name: string;
    unit: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }[];
  subtotal: number;
  total: number;
  businessName: string;
  address?: string;
  phone1?: string;
  phone2?: string;
  receiptFooter: string;
};

export type ThermalReturnReceipt = {
  returnNumber: string;
  originalInvoice: string;
  date: string;
  items: {
    name: string;
    unit: string;
    quantity: number;
    unitPrice: number;
    refundAmount: number;
  }[];
  refundTotal: number;
  reason?: string | null;
  businessName: string;
  address?: string;
  phone1?: string;
  phone2?: string;
  receiptFooter: string;
};

export interface PrintProvider {
  printSaleReceipt(receipt: ThermalSaleReceipt): Promise<void>;
  printReturnReceipt(receipt: ThermalReturnReceipt): Promise<void>;
}

/**
 * Standard browser printing provider for Windows PC connected to 80mm thermal receipt printer.
 * Invokes native window.print() against clean, printer-safe 80mm layout with zero margins.
 */
export class BrowserPrintProvider implements PrintProvider {
  async printSaleReceipt(): Promise<void> {
    if (typeof window !== 'undefined') {
      window.print();
    }
  }

  async printReturnReceipt(): Promise<void> {
    if (typeof window !== 'undefined') {
      window.print();
    }
  }
}

/**
 * Extensible provider for future direct hardware / ESC/POS / QZ-Tray integration.
 * Can be configured without rewriting sales, returns, or financial logic.
 */
export class QZTrayPrintProvider implements PrintProvider {
  async printSaleReceipt(receipt: ThermalSaleReceipt): Promise<void> {
    // Scaffold for future direct ESC/POS socket / QZ-Tray connection
    console.info('QZ-Tray / ESC-POS direct printing scaffold invoked for sale', receipt.invoiceNumber);
    if (typeof window !== 'undefined') {
      window.print();
    }
  }

  async printReturnReceipt(receipt: ThermalReturnReceipt): Promise<void> {
    console.info('QZ-Tray / ESC-POS direct printing scaffold invoked for return', receipt.returnNumber);
    if (typeof window !== 'undefined') {
      window.print();
    }
  }
}

let defaultProvider: PrintProvider = new BrowserPrintProvider();

export function getPrintProvider(): PrintProvider {
  return defaultProvider;
}

export function setPrintProvider(provider: PrintProvider): void {
  defaultProvider = provider;
}
