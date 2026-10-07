'use client';

import { use, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { offlineDb } from '@/lib/db/offline-db';
import { formatMoney, formatQuantity } from '@/lib/calculations';
import { Printer, ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export default function SaleReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const supabase = getSupabase();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sale, setSale] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [settings, setSettings] = useState({
    business_name: 'Aziz & Son Wholesaler',
    address: '',
    phone1: '',
    phone2: '',
    receipt_footer: 'Thank you for your business!'
  });

  useEffect(() => {
    async function fetchReceipt() {
      try {
        // 1. Try local IndexedDB first (works 100% offline!)
        const localSale = await offlineDb.sales.get(id);
        if (localSale) {
          const localItems = await offlineDb.sale_items.where('sale_id').equals(id).toArray();
          setSale(localSale);
          setItems(localItems);
          setLoading(false);
          return;
        }

        // 2. Cloud fallback if online
        if (!supabase) return;
        const [saleRes, itemsRes, settingsRes] = await Promise.all([
          supabase.from('sales').select('*').eq('id', id).maybeSingle(),
          supabase.from('sale_items').select('*').eq('sale_id', id).order('id'),
          supabase.from('business_settings').select('*').maybeSingle()
        ]);

        if (saleRes.error) throw saleRes.error;
        if (!saleRes.data) throw new Error('Sale invoice not found.');
        if (itemsRes.error) throw itemsRes.error;

        setSale(saleRes.data);
        setItems(itemsRes.data || []);
        if (settingsRes.data) {
          setSettings({
            business_name: settingsRes.data.business_name || 'Aziz & Son Wholesaler',
            address: settingsRes.data.address || '',
            phone1: settingsRes.data.phone1 || '',
            phone2: settingsRes.data.phone2 || '',
            receipt_footer: settingsRes.data.receipt_footer || 'Thank you for your business!'
          });
        }
      } catch (err: any) {
        setError(err.message || 'Failed to load receipt.');
      } finally {
        setLoading(false);
      }
    }
    fetchReceipt();
  }, [supabase, id]);

  if (loading) {
    return (
      <div style={{ padding: '20px', fontFamily: 'sans-serif', textAlign: 'center' }}>
        Loading 80mm receipt...
      </div>
    );
  }

  if (error || !sale) {
    return (
      <div style={{ padding: '20px', fontFamily: 'sans-serif', textAlign: 'center' }}>
        <p style={{ color: 'red' }}>{error || 'Receipt not found.'}</p>
        <Link href="/" style={{ color: '#264b3b' }}>← Return to Dashboard</Link>
      </div>
    );
  }

  return (
    <>
      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 0;
        }
        @media print {
          body, html {
            width: 80mm !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
          }
          .no-print {
            display: none !important;
          }
          .receipt-container {
            box-shadow: none !important;
            margin: 0 auto !important;
            padding: 2mm 1.5mm !important;
          }
        }
      `}</style>

      {/* Screen action bar */}
      <div className="no-print" style={{
        display: 'flex',
        justifyContent: 'center',
        gap: '12px',
        padding: '16px',
        background: '#202d28',
        color: '#fff'
      }}>
        <Link href="/" style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          color: '#eff3ee',
          textDecoration: 'none',
          padding: '8px 14px',
          background: 'rgba(255,255,255,0.1)',
          borderRadius: '4px',
          fontSize: '13px'
        }}>
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
        <button
          onClick={() => window.print()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 18px',
            background: '#bb8744',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <Printer size={16} /> Print Receipt (80mm)
        </button>
      </div>

      {/* 80mm thermal container */}
      <div style={{ minHeight: '100vh', background: '#f4f5f1', padding: '20px 0' }}>
        <article className="receipt-container" style={{
          width: '74mm',
          margin: '0 auto',
          background: '#fff',
          color: '#000',
          padding: '3mm 2mm',
          fontFamily: 'Arial, sans-serif',
          fontSize: '9.5px',
          lineHeight: '1.25',
          boxShadow: '0 4px 20px rgba(0,0,0,0.1)'
        }}>
          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: '2mm' }}>
            <h1 style={{ margin: '0', fontSize: '13px', fontWeight: 'bold' }}>{settings.business_name}</h1>
            {settings.address && <p style={{ margin: '1mm 0 0', fontSize: '8px' }}>{settings.address}</p>}
            {(settings.phone1 || settings.phone2) && (
              <p style={{ margin: '0.5mm 0 0', fontSize: '8px' }}>
                Tel: {[settings.phone1, settings.phone2].filter(Boolean).join(' / ')}
              </p>
            )}
            <div style={{ margin: '1.5mm 0', fontSize: '10.5px', fontWeight: 'bold' }}>SALE RECEIPT</div>
          </div>

          <div style={{ borderTop: '1px dashed #000', margin: '1.5mm 0' }} />

          {/* Metadata */}
          <div style={{ fontSize: '8.5px', marginBottom: '1.5mm' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Invoice: <b>{sale.invoice_number}</b></span>
              <span>Date: {sale.sale_date}</span>
            </div>
            {sale.customer_name && (
              <div style={{ marginTop: '0.5mm' }}>Customer: <b>{sale.customer_name}</b></div>
            )}
          </div>

          <div style={{ borderTop: '1px solid #000', margin: '1mm 0' }} />

          {/* Items Table */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '8.5px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #000', textAlign: 'left' }}>
                <th style={{ padding: '1mm 0' }}>Item</th>
                <th style={{ padding: '1mm 0', textAlign: 'right' }}>Qty</th>
                <th style={{ padding: '1mm 0', textAlign: 'right' }}>Rate</th>
                <th style={{ padding: '1mm 0', textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={item.id || index} style={{ borderBottom: '1px dotted #ccc' }}>
                  <td style={{ padding: '1.2mm 0', fontWeight: 'bold' }}>
                    {item.product_name_snapshot}
                  </td>
                  <td style={{ padding: '1.2mm 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {formatQuantity(item.quantity)} {item.unit_snapshot}
                  </td>
                  <td style={{ padding: '1.2mm 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {formatQuantity(item.unit_sale_price || item.unit_price)}
                  </td>
                  <td style={{ padding: '1.2mm 0', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 'bold' }}>
                    {formatQuantity(item.line_total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div style={{ borderTop: '2px solid #000', marginTop: '2mm', paddingTop: '1.5mm' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 'bold' }}>
              <span>TOTAL</span>
              <span>{formatMoney(sale.total || sale.net_total)}</span>
            </div>
          </div>
          <div style={{ borderBottom: '2px solid #000', marginTop: '1.5mm', marginBottom: '2.5mm' }} />

          {/* Footer */}
          <div style={{ textAlign: 'center', fontSize: '8.5px', marginTop: '2mm' }}>
            {settings.receipt_footer || 'Thank you for your business!'}
          </div>
        </article>
      </div>
    </>
  );
}
