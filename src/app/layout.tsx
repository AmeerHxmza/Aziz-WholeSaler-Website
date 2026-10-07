import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aziz & Son | Wholesale Ledger',
  description: 'Products, inventory, sales and returns for Aziz & Son Wholesaler.'
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
