'use client';

import { useEffect, useEffectEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  Boxes,
  ChartNoAxesCombined,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  Clock,
  Coins,
  FileText,
  LayoutDashboard,
  LogOut,
  PackagePlus,
  Pencil,
  Plus,
  Printer,
  Power,
  RefreshCw,
  Search,
  Settings2,
  ShoppingCart,
  Undo2,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import { offlineDb } from '@/lib/db/offline-db';
import {
  createOfflineSale,
  createOfflineReturn,
  recordOfflineStock,
  saveOfflineProduct,
  deduplicateLocalProducts
} from '@/lib/db/offline-operations';
import { SearchableProductSelect } from '@/components/SearchableProductSelect';
import { syncEngine, type SyncStatusState } from '@/lib/sync/sync-engine';
import {
  amount,
  formatMoney,
  formatQuantity,
  lineAmount,
  quantity,
  roundMoney
} from '@/lib/calculations';
import { getSupabase } from '@/lib/supabase';
import { fetchAllRows } from '@/lib/fetch-all';
import { createReceiptPdf } from '@/lib/receipt-pdf';

type Product = {
  id: string;
  name: string;
  unit: string;
  purchase_cost: number;
  sale_price: number;
  minimum_stock: number;
  active: boolean;
  stock: number;
};
type SaleItem = {
  id: number;
  sale_id: string;
  product_id: string;
  product_name_snapshot: string;
  unit_snapshot: string;
  purchase_cost_snapshot: number;
  cost_total_snapshot: number;
  quantity: number;
  unit_price: number;
  line_total: number;
};
type Sale = {
  id: string;
  invoice_number: string;
  sale_date: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  net_total: number;
  original_profit?: number;
  status: string;
  notes: string | null;
  created_at: string;
  items: SaleItem[];
};
type ReturnRow = {
  id: number | string;
  bill_number: string;
  sale_id: string | null;
  invoice_number: string | null;
  product_id: string;
  product_name_snapshot: string;
  unit_snapshot: string;
  quantity: number;
  refund_amount: number;
  cost_amount_snapshot: number;
  restock: boolean;
  reason: string;
  movement_date: string;
};
type Loan = {
  id: string;
  person_name: string;
  type: 'GIVEN' | 'TAKEN';
  amount: number;
  paid_amount: number;
  remaining_amount: number;
  status: string;
  loan_date: string;
  notes: string | null;
};
type ReceiptRecord = {
  kind: 'SALE' | 'RETURN';
  number: string;
  date: string;
  reference?: string;
  customerName?: string | null;
  customerPhone?: string | null;
  totalLabel: string;
  total: number;
  notes?: string;
  items: { name: string; unit: string; quantity: number; rate: number; amount: number; note?: string }[];
};
type Tab =
  | 'overview'
  | 'sales'
  | 'products'
  | 'returns'
  | 'money'
  | 'reports'
  | 'settings';
type CartLine = { productId: string; quantity: string; unitPrice: string };

const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const defaultSettings = {
  business_name: 'Aziz & Son Wholesaler',
  address: '',
  phone1: '',
  phone2: '',
  receipt_footer: 'Thank you for your business!'
};
const navItems: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'sales', label: 'New sale', icon: ShoppingCart },
  { id: 'products', label: 'Products', icon: Boxes },
  { id: 'returns', label: 'Returns', icon: Undo2 },
  { id: 'money', label: 'Money ledger', icon: Coins },
  { id: 'reports', label: 'Reports', icon: ChartNoAxesCombined },
  { id: 'settings', label: 'Settings', icon: Settings2 }
];

function saleReceipt(sale: Sale): ReceiptRecord {
  return {
    kind: 'SALE',
    number: sale.invoice_number,
    date: sale.sale_date,
    customerName: sale.customer_name,
    customerPhone: sale.customer_phone,
    totalLabel: 'TOTAL',
    total: sale.net_total,
    items: sale.items.map((item) => ({
      name: item.product_name_snapshot,
      unit: item.unit_snapshot,
      quantity: item.quantity,
      rate: item.unit_price,
      amount: item.line_total
    }))
  };
}

function savedReturnReceipt(selected: ReturnRow, returns: ReturnRow[], sales?: Sale[]): ReceiptRecord {
  const rows = returns.filter((row) => row.bill_number === selected.bill_number);
  const matchedSale = sales?.find((s) => (selected.sale_id && s.id === selected.sale_id) || (selected.invoice_number && s.invoice_number === selected.invoice_number));
  return {
    kind: 'RETURN',
    number: selected.bill_number,
    date: selected.movement_date,
    reference: selected.invoice_number || undefined,
    customerName: matchedSale?.customer_name,
    customerPhone: matchedSale?.customer_phone,
    totalLabel: 'REFUND',
    total: roundMoney(rows.reduce((sum, row) => sum + row.refund_amount, 0)),
    notes: selected.reason,
    items: rows.map((row) => ({
      name: row.product_name_snapshot,
      unit: row.unit_snapshot,
      quantity: row.quantity,
      rate: row.quantity ? row.refund_amount / row.quantity : 0,
      amount: row.refund_amount,
      note: row.restock ? undefined : 'Damaged / not added to stock'
    }))
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
    if ('error_description' in error && typeof (error as { error_description: unknown }).error_description === 'string') {
      return (error as { error_description: string }).error_description;
    }
    if ('details' in error && typeof (error as { details: unknown }).details === 'string') {
      return (error as { details: string }).details;
    }
  }
  if (typeof error === 'string') return error;
  return 'The request could not be completed.';
}

export default function Home() {
  const supabase = getSupabase();
  const [session, setSession] = useState<{ id: string; email?: string } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [email, setEmail] = useState('aziz@gmail.com');
  const [accountEmail, setAccountEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [settings, setSettings] = useState(defaultSettings);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [syncState, setSyncState] = useState<SyncStatusState>(syncEngine.getState());
  const [receipt, setReceipt] = useState<ReceiptRecord | null>(null);
  const [search, setSearch] = useState('');
  const [productFilter, setProductFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE' | 'LOW_STOCK'>('ALL');
  const [reportStart, setReportStart] = useState(today());
  const [reportEnd, setReportEnd] = useState(today());
  const [cart, setCart] = useState<CartLine[]>([{ productId: '', quantity: '1', unitPrice: '' }]);
  const [saleCustomerName, setSaleCustomerName] = useState('');
  const [saleCustomerPhone, setSaleCustomerPhone] = useState('');
  const [quickStockProduct, setQuickStockProduct] = useState<Product | null>(null);
  const [quickStockQty, setQuickStockQty] = useState('');
  const [quickStockCost, setQuickStockCost] = useState('');
  const [newProduct, setNewProduct] = useState({
    name: '',
    unit: 'Box',
    purchase_cost: '',
    sale_price: '',
    minimum_stock: '10',
    opening_stock: ''
  });
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [stockForm, setStockForm] = useState({
    productId: '',
    quantity: '',
    purchaseCost: '',
    date: today(),
    movementType: 'PURCHASE',
    notes: ''
  });
  const [adjustForm, setAdjustForm] = useState({
    productId: '',
    type: 'PHYSICAL',
    quantity: '',
    physicalCount: '',
    reason: '',
    date: today()
  });
  const [returnForm, setReturnForm] = useState({
    saleId: '',
    productId: '',
    quantity: '',
    restock: true,
    reason: 'Customer return',
    date: today(),
    refund: ''
  });
  const [loanForm, setLoanForm] = useState({
    person: '',
    type: 'GIVEN' as 'GIVEN' | 'TAKEN',
    amount: '',
    date: today()
  });
  const [settlement, setSettlement] = useState({ loanId: '', amount: '', date: today() });
  const [businessForm, setBusinessForm] = useState(settings);
  const [resetPhrase, setResetPhrase] = useState('');

  useEffect(() => {
    // 1. Immediately recover trusted POS installation from localStorage
    try {
      const trusted = localStorage.getItem('aziz_pos_trusted_device');
      if (trusted) {
        const parsed = JSON.parse(trusted);
        if (parsed?.id) {
          setSession({ id: parsed.id, email: parsed.email });
          setAccountEmail(parsed.email || '');
        }
      }
    } catch {}

    const unsub = syncEngine.subscribe((state) => {
      setSyncState(state);
    });

    void refreshFromOfflineDb().then(() => {
      void syncEngine.sync().then(() => refreshFromOfflineDb());
    });

    if (!supabase) return unsub;

    supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user;
      if (user) {
        setSession({ id: user.id, email: user.email });
        setAccountEmail(user.email || '');
        localStorage.setItem(
          'aziz_pos_trusted_device',
          JSON.stringify({ id: user.id, email: user.email, trustedAt: new Date().toISOString() })
        );
      }
    }).catch(() => {
      // Offline: network error ignored, trusted device keeps working
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, authSession) => {
      const user = authSession?.user;
      if (user) {
        setSession({ id: user.id, email: user.email });
        setAccountEmail(user.email || '');
        localStorage.setItem(
          'aziz_pos_trusted_device',
          JSON.stringify({ id: user.id, email: user.email, trustedAt: new Date().toISOString() })
        );
      } else if (event === 'SIGNED_OUT') {
        localStorage.removeItem('aziz_pos_trusted_device');
        setSession(null);
        setAccountEmail('');
      }
    });

    return () => {
      unsub();
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  async function refreshFromOfflineDb() {
    try {
      await deduplicateLocalProducts();
      const localProducts = await offlineDb.products.toArray();
      const localSales = await offlineDb.sales.orderBy('created_at').reverse().toArray();
      const localSaleItems = await offlineDb.sale_items.toArray();
      const localReturns = await offlineDb.returns.orderBy('created_at').reverse().toArray();
      const localReturnItems = await offlineDb.return_items.toArray();

      const localLoansRecord = await offlineDb.settings.get('cloud_loans');
      const localSettingsRecord = await offlineDb.settings.get('cloud_settings');

      setProducts(
        localProducts.map((p) => ({
          id: p.id,
          name: p.name,
          unit: p.unit,
          purchase_cost: Number(p.average_cost ?? p.purchase_cost ?? 0),
          sale_price: Number(p.sale_price ?? 0),
          minimum_stock: Number(p.minimum_stock ?? 10),
          active: p.active,
          stock: Number(p.current_stock ?? 0)
        }))
      );

      setSales(
        localSales.map((s) => {
          const items = localSaleItems
            .filter((si) => si.sale_id === s.id)
            .map((si, idx) => ({
              id: idx + 1,
              sale_id: s.id,
              product_id: si.product_id,
              product_name_snapshot: si.product_name_snapshot,
              unit_snapshot: si.unit_snapshot,
              purchase_cost_snapshot: Number(si.unit_cost_snapshot || 0),
              cost_total_snapshot: Number((si.unit_cost_snapshot || 0) * si.quantity),
              quantity: Number(si.quantity),
              unit_price: Number(si.unit_sale_price),
              line_total: Number(si.line_total)
            }));

          return {
            id: s.id,
            invoice_number: s.invoice_number,
            sale_date: s.sale_date,
            customer_name: s.customer_name || null,
            customer_phone: s.customer_phone || null,
            subtotal: Number(s.subtotal),
            total: Number(s.total),
            net_total: Number(s.net_total),
            original_profit: Number(s.original_profit || 0),
            status: s.status,
            notes: s.notes || null,
            created_at: s.created_at,
            items
          };
        })
      );

      setReturns(
        localReturns.map((r) => {
          const rItem = localReturnItems.find((ri) => ri.return_id === r.id);
          const prod = localProducts.find((p) => p.id === rItem?.product_id);
          const sale = localSales.find((s) => s.id === r.sale_id);
          return {
            id: r.id,
            bill_number: r.return_number,
            sale_id: r.sale_id,
            invoice_number: r.invoice_number || sale?.invoice_number || null,
            product_id: rItem?.product_id || '',
            product_name_snapshot: prod?.name || 'Returned item',
            unit_snapshot: prod?.unit || 'Units',
            quantity: Number(rItem?.quantity_returned || 0),
            refund_amount: Number(r.refund_total),
            cost_amount_snapshot: Number(rItem ? (rItem.unit_cost_snapshot || 0) * rItem.quantity_returned : 0),
            restock: true,
            reason: r.reason || 'Customer return',
            movement_date: r.return_date
          };
        })
      );

      if (localLoansRecord?.value) {
        setLoans(localLoansRecord.value);
      } else {
        setLoans([]);
      }
      if (localSettingsRecord?.value) {
        setSettings(localSettingsRecord.value);
        setBusinessForm(localSettingsRecord.value);
      } else {
        setSettings(defaultSettings);
        setBusinessForm(defaultSettings);
      }
    } catch (err) {
      console.warn('Error reading offline DB:', err);
    }
  }

  async function loadData() {
    setLoading(true);
    setError('');
    try {
      // 1. Immediately read from local IndexedDB
      await refreshFromOfflineDb();

      // 2. If online and Supabase is reachable, perform two-way sync
      if (syncState.isOnline || (typeof navigator !== 'undefined' && navigator.onLine)) {
        await syncEngine.sync();
        await refreshFromOfflineDb();
      }
    } catch (cause) {
      console.warn('Sync failed, working locally:', cause);
    } finally {
      setLoading(false);
    }
  }

  const loadDataEffect = useEffectEvent(loadData);
  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => void loadDataEffect(), 0);
    return () => window.clearTimeout(timer);
  }, [session]);

  async function runAction<T>(action: () => Promise<T>, success: string): Promise<T | null> {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await action();
      setMessage(success);
      await loadData();
      return result;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function authenticate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) {
        setError(result.error.message);
      } else if (result.data?.user) {
        localStorage.setItem(
          'aziz_pos_trusted_device',
          JSON.stringify({
            id: result.data.user.id,
            email: result.data.user.email,
            trustedAt: new Date().toISOString()
          })
        );
        const { error: claimError } = await supabase.rpc('claim_shop_admin');
        if (claimError) {
          localStorage.removeItem('aziz_pos_trusted_device');
          await supabase.auth.signOut();
          setError(claimError.message);
        }
      }
    } catch (cause) {
      setError(
        navigator.onLine
          ? errorText(cause)
          : 'First-time setup requires internet to link this POS terminal. Please reconnect and sign in once.'
      );
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    localStorage.removeItem('aziz_pos_trusted_device');
    setSession(null);
    setAccountEmail('');
    if (supabase) {
      await supabase.auth.signOut().catch(() => {});
    }
  }

  async function updateCredentials(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !session) return;
    const nextEmail = accountEmail.trim().toLowerCase();
    const changingEmail = nextEmail !== (session.email || '').toLowerCase();
    if (!changingEmail && !newPassword) {
      setError('Enter a new login email or password.');
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setError('Use a password with at least 8 characters.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const { error: updateError } = await supabase.auth.updateUser({
      ...(changingEmail ? { email: nextEmail } : {}),
      ...(newPassword ? { password: newPassword } : {})
    });
    if (updateError) setError(updateError.message);
    else {
      setNewPassword('');
      setConfirmNewPassword('');
      setMessage(changingEmail ? 'Check the new email inbox to confirm the login change.' : 'Password changed.');
    }
    setBusy(false);
  }

  const activeProducts = products.filter((product) => product.active);
  const visibleProducts = products.filter((product) => {
    const matchesSearch = `${product.name} ${product.unit}`.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;
    if (productFilter === 'ACTIVE') return product.active;
    if (productFilter === 'INACTIVE') return !product.active;
    if (productFilter === 'LOW_STOCK') return product.active && product.stock <= product.minimum_stock;
    return true;
  });
  const returnSales = sales.filter((sale) => ['COMPLETED', 'PARTIALLY_RETURNED', 'CONFIRMED'].includes(sale.status));
  const selectedReturnSale = returnSales.find((sale) => sale.id === returnForm.saleId);
  const selectedReturnItem = selectedReturnSale?.items.find(
    (item) => item.product_id === returnForm.productId
  );
  const getSaleProfit = (s: Sale): number => {
    if (s.items && s.items.length > 0) {
      return s.items.reduce(
        (sum, item) => sum + (Number(item.line_total) - Number(item.cost_total_snapshot || (item.purchase_cost_snapshot * item.quantity) || 0)),
        0
      );
    }
    return Number((s as any).original_profit || 0);
  };

  const getReturnProfitReduction = (row: ReturnRow): number => {
    const refund = Number(row.refund_amount ?? (row as any).refund_total ?? 0);
    const cost = row.restock ? Number(row.cost_amount_snapshot || 0) : 0;
    return refund - cost;
  };

  const todaySales = sales.filter((sale) => {
    const d = sale.sale_date || sale.created_at?.slice(0, 10);
    return d === today() && sale.status !== 'VOIDED';
  });
  const todayRefunds = returns.filter((row) => {
    const d = row.movement_date || (row as unknown as { return_date?: string }).return_date || (row as unknown as { created_at?: string }).created_at?.slice(0, 10);
    return d === today();
  });
  const todayNetSales = roundMoney(
    todaySales.reduce((sum, sale) => sum + Number(sale.net_total), 0) -
      todayRefunds.reduce((sum, row) => sum + Number(row.refund_amount ?? (row as any).refund_total ?? 0), 0)
  );
  const todayProfit = roundMoney(
    todaySales.reduce((sum, sale) => sum + getSaleProfit(sale), 0) -
      todayRefunds.reduce((sum, row) => sum + getReturnProfitReduction(row), 0)
  );
  const stockValue = roundMoney(
    products.reduce((sum, product) => sum + Math.max(0, product.stock) * product.purchase_cost, 0)
  );
  const lowStock = products.filter(
    (product) => product.active && product.stock <= product.minimum_stock
  );
  const reportSales = sales.filter((sale) => {
    const d = sale.sale_date || sale.created_at?.slice(0, 10);
    return d && d >= reportStart && d <= reportEnd && sale.status !== 'VOIDED';
  });
  const reportReturns = returns.filter((row) => {
    const d = row.movement_date || (row as unknown as { return_date?: string }).return_date || (row as unknown as { created_at?: string }).created_at?.slice(0, 10);
    return d && d >= reportStart && d <= reportEnd;
  });
  const reportNet = roundMoney(
    reportSales.reduce((sum, sale) => sum + Number(sale.net_total), 0) -
      reportReturns.reduce((sum, row) => sum + Number(row.refund_amount ?? (row as any).refund_total ?? 0), 0)
  );
  const reportProfit = roundMoney(
    reportSales.reduce((sum, sale) => sum + getSaleProfit(sale), 0) -
      reportReturns.reduce((sum, row) => sum + getReturnProfitReduction(row), 0)
  );
  const outstandingIn = roundMoney(
    loans
      .filter((loan) => loan.type === 'GIVEN')
      .reduce((sum, loan) => sum + loan.remaining_amount, 0)
  );
  const outstandingOut = roundMoney(
    loans
      .filter((loan) => loan.type === 'TAKEN')
      .reduce((sum, loan) => sum + loan.remaining_amount, 0)
  );

  async function createProduct(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const purchaseCost =
        editingProduct && editingProduct.stock > 0
          ? editingProduct.purchase_cost
          : amount(newProduct.purchase_cost, 'Buying rate');
      const salePrice = amount(newProduct.sale_price, 'Selling rate');
      const minimum = quantity(newProduct.minimum_stock, true);
      if (!newProduct.name.trim() || !newProduct.unit.trim())
        throw new Error('Product name and selling unit are required.');
      const openingStock = quantity(newProduct.opening_stock || '0', true);

      setBusy(true);
      await saveOfflineProduct({
        id: editingProduct?.id,
        name: newProduct.name,
        unit: newProduct.unit,
        purchaseCost,
        salePrice,
        minimumStock: minimum,
        openingStock,
        active: editingProduct?.active
      });

      setMessage(editingProduct ? 'Product updated locally.' : 'Product saved with starting stock.');
      setEditingProduct(null);
      setNewProduct({
        name: '',
        unit: 'Box',
        purchase_cost: '',
        sale_price: '',
        minimum_stock: '10',
        opening_stock: ''
      });
      await refreshFromOfflineDb();
      setBusy(false);

      void syncEngine.sync().then(() => refreshFromOfflineDb());
    } catch (cause) {
      setBusy(false);
      setError(errorText(cause));
    }
  }

  function beginEditProduct(product: Product) {
    setEditingProduct(product);
    setNewProduct({
      name: product.name,
      unit: product.unit,
      purchase_cost: String(product.purchase_cost),
      sale_price: String(product.sale_price),
      minimum_stock: String(product.minimum_stock),
      opening_stock: ''
    });
    setError('');
    setMessage('');
    window.requestAnimationFrame(() => document.getElementById('product-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'F2' || document.querySelector('[role=dialog]')) return;
      event.preventDefault();
      setTab('sales');
      setCart([{ productId: '', quantity: '1', unitPrice: '' }]);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  async function toggleProductActive(product: Product) {
    try {
      setBusy(true);
      await saveOfflineProduct({
        id: product.id,
        name: product.name,
        unit: product.unit,
        purchaseCost: product.purchase_cost,
        salePrice: product.sale_price,
        minimumStock: product.minimum_stock,
        active: !product.active
      });
      setMessage(product.active ? 'Product deactivated.' : 'Product activated.');
      await refreshFromOfflineDb();
      setBusy(false);
      void syncEngine.sync().then(() => refreshFromOfflineDb());
    } catch (cause) {
      setBusy(false);
      setError(errorText(cause));
    }
  }

  async function createSale(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const items = cart
        .filter((line) => line.productId)
        .map((line) => ({
          productId: line.productId,
          quantity: quantity(line.quantity),
          ...(line.unitPrice ? { unitPrice: Number(line.unitPrice) } : {})
        }));
      if (!items.length) throw new Error('Add at least one product to the bill.');
      if (new Set(items.map((item) => item.productId)).size !== items.length)
        throw new Error('Each product can appear once. Edit its existing line quantity.');

      // Immediate client-side validation against stock
      for (const item of items) {
        const prod = products.find((p) => p.id === item.productId);
        if (prod && item.quantity > prod.stock) {
          throw new Error(`Only ${formatQuantity(prod.stock)} ${prod.unit} available of "${prod.name}". You attempted to sell ${item.quantity}.`);
        }
      }

      // 11-digit mobile validation
      const cleanPhone = saleCustomerPhone.trim();
      if (cleanPhone && cleanPhone.length !== 11) {
        throw new Error('Customer mobile number must be exactly 11 digits (e.g. 03001234567).');
      }

      setBusy(true);
      const offlineResult = await createOfflineSale({
        items,
        customerName: saleCustomerName.trim() || null,
        customerPhone: cleanPhone || null,
        notes: null
      });

      setReceipt({
        kind: 'SALE',
        number: offlineResult.sale.invoice_number,
        date: today(),
        customerName: saleCustomerName.trim() || null,
        customerPhone: cleanPhone || null,
        totalLabel: 'TOTAL',
        total: Number(offlineResult.sale.net_total),
        items: items.map((line) => {
          const product = products.find((candidate) => candidate.id === line.productId)!;
          const rate = line.unitPrice ?? product.sale_price;
          return {
            name: product.name,
            unit: product.unit,
            quantity: line.quantity,
            rate,
            amount: lineAmount(line.quantity, rate)
          };
        })
      });

      setCart([{ productId: '', quantity: '1', unitPrice: '' }]);
      setSaleCustomerName('');
      setSaleCustomerPhone('');
      setMessage(`Sale ${offlineResult.sale.invoice_number} saved.`);

      await refreshFromOfflineDb();
      setBusy(false);

      void syncEngine.sync().then(() => refreshFromOfflineDb());
    } catch (cause) {
      setBusy(false);
      setError(errorText(cause));
    }
  }

  function openQuickStock(product: Product) {
    setQuickStockProduct(product);
    setQuickStockQty('');
    setQuickStockCost(String(product.purchase_cost || ''));
    setError('');
    setMessage('');
  }

  async function handleQuickStockSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quickStockProduct) return;
    try {
      const qty = quantity(quickStockQty);
      const cost = amount(quickStockCost, 'Buying rate');
      setBusy(true);
      await recordOfflineStock({
        productId: quickStockProduct.id,
        quantity: qty,
        purchaseCost: cost,
        movementType: 'PURCHASE',
        date: today(),
        notes: 'Quick restock'
      });
      setMessage(`Added ${qty} ${quickStockProduct.unit} to ${quickStockProduct.name}.`);
      setQuickStockProduct(null);
      setQuickStockQty('');
      setQuickStockCost('');

      await refreshFromOfflineDb();
      setBusy(false);

      void syncEngine.sync().then(() => refreshFromOfflineDb());
    } catch (cause) {
      setBusy(false);
      setError(errorText(cause));
    }
  }

  async function addStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const qty = quantity(stockForm.quantity);
      const cost = amount(stockForm.purchaseCost, 'Buying rate');
      setBusy(true);
      await recordOfflineStock({
        productId: stockForm.productId,
        quantity: qty,
        purchaseCost: cost,
        movementType: stockForm.movementType as any,
        date: stockForm.date,
        notes: stockForm.notes || null
      });
      setMessage('Stock recorded and average buying cost recalculated.');
      setStockForm({
        productId: '',
        quantity: '',
        purchaseCost: '',
        date: today(),
        movementType: 'PURCHASE',
        notes: ''
      });

      await refreshFromOfflineDb();
      setBusy(false);

      void syncEngine.sync().then(() => refreshFromOfflineDb());
    } catch (cause) {
      setBusy(false);
      setError(errorText(cause));
    }
  }

  async function adjustStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    try {
      if (!adjustForm.productId) throw new Error('Choose a product.');
      if (!adjustForm.reason.trim()) throw new Error('Enter a reason for the stock adjustment.');
      if (adjustForm.type === 'PHYSICAL') quantity(adjustForm.physicalCount, true);
      else quantity(adjustForm.quantity);
      await runAction(async () => {
        const { error: rpcError } = await supabase.rpc('adjust_stock', {
          p_product_id: adjustForm.productId,
          p_adjustment_type: adjustForm.type,
          p_quantity: adjustForm.type === 'PHYSICAL' ? null : Number(adjustForm.quantity),
          p_physical_count: adjustForm.type === 'PHYSICAL' ? Number(adjustForm.physicalCount) : null,
          p_reason: adjustForm.reason.trim(),
          p_date: adjustForm.date,
          p_notes: null
        });
        if (rpcError) throw rpcError;
      }, 'Stock count reconciled and movement recorded.');
      setAdjustForm({ productId: '', type: 'PHYSICAL', quantity: '', physicalCount: '', reason: '', date: today() });
      await refreshFromOfflineDb();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function createReturn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const qty = quantity(returnForm.quantity);
      if (!returnForm.saleId) throw new Error('Please select the original sales bill to return items from.');
      if (!returnForm.productId) throw new Error('Choose a product to return.');
      const selectedProduct = products.find((product) => product.id === returnForm.productId);

      setBusy(true);
      const offlineResult = await createOfflineReturn({
        saleId: returnForm.saleId,
        items: [{ productId: returnForm.productId, quantity: qty }],
        reason: returnForm.reason
      });

      setReceipt({
        kind: 'RETURN',
        number: offlineResult.returnRow.return_number,
        date: returnForm.date,
        reference: selectedReturnSale?.invoice_number,
        totalLabel: 'REFUND TOTAL',
        total: offlineResult.returnRow.refund_total,
        notes: `${returnForm.reason}${returnForm.restock ? '' : ' · Damaged / not added to stock'}`,
        items: [{
          name: selectedReturnItem?.product_name_snapshot || selectedProduct?.name || 'Returned item',
          unit: selectedReturnItem?.unit_snapshot || selectedProduct?.unit || '',
          quantity: qty,
          rate: qty ? offlineResult.returnRow.refund_total / qty : 0,
          amount: offlineResult.returnRow.refund_total,
          note: returnForm.restock ? undefined : 'Damaged / not added to stock'
        }]
      });

      setReturnForm({
        saleId: '',
        productId: '',
        quantity: '',
        restock: true,
        reason: 'Customer return',
        date: today(),
        refund: ''
      });
      setMessage(`Return ${offlineResult.returnRow.return_number} saved.`);

      await refreshFromOfflineDb();
      setBusy(false);

      void syncEngine.sync().then(() => refreshFromOfflineDb());
    } catch (cause) {
      setBusy(false);
      setError(errorText(cause));
    }
  }

  async function createLoan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    await runAction(async () => {
      const { error: rpcError } = await supabase.rpc('create_loan', {
        p_person_name: loanForm.person,
        p_type: loanForm.type,
        p_amount: Number(loanForm.amount),
        p_date: loanForm.date,
        p_notes: null
      });
      if (rpcError) throw rpcError;
    }, 'Money record saved.');
    setLoanForm({ person: '', type: 'GIVEN', amount: '', date: today() });
  }

  async function settleLoan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    await runAction(async () => {
      const { error: rpcError } = await supabase.rpc('settle_loan', {
        p_loan_id: settlement.loanId,
        p_amount: Number(settlement.amount),
        p_date: settlement.date,
        p_notes: null
      });
      if (rpcError) throw rpcError;
    }, 'Repayment saved and balance updated.');
    setSettlement({ loanId: '', amount: '', date: today() });
  }

  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !session) return;
    await runAction(async () => {
      const { error: rpcError } = await supabase.rpc('save_business_settings', {
        p_business_name: businessForm.business_name,
        p_address: businessForm.address,
        p_phone1: businessForm.phone1,
        p_phone2: businessForm.phone2,
        p_receipt_footer: businessForm.receipt_footer
      });
      if (rpcError) throw rpcError;
      setSettings(businessForm);
    }, 'Business details saved.');
  }

  async function resetShopData(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || resetPhrase !== 'RESET AZIZ SHOP') {
      setError('Type RESET AZIZ SHOP exactly to continue.');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const [settingsBackup, productBackup, stockBackup, adjustmentBackup, invoiceBackup, returnSequenceBackup, salesBackup, itemsBackup, returnsBackup, loansBackup, settlementsBackup, auditBackup] = await Promise.all([
        supabase.from('business_settings').select('*').maybeSingle(),
        fetchAllRows((from, to) => supabase.from('products').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('stock_movements').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('stock_adjustments').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('invoice_sequences').select('*').order('year').range(from, to)),
        fetchAllRows((from, to) => supabase.from('return_sequences').select('*').order('year').range(from, to)),
        fetchAllRows((from, to) => supabase.from('sales').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('sale_items').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('returns').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('loans').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('loan_settlements').select('*').order('id').range(from, to)),
        fetchAllRows((from, to) => supabase.from('audit_log').select('*').order('id').range(from, to))
      ]);
      if (settingsBackup.error) throw new Error(settingsBackup.error.message);
      const backup = {
        exportedAt: new Date().toISOString(),
        business_settings: settingsBackup.data,
        products: productBackup,
        stock_movements: stockBackup,
        stock_adjustments: adjustmentBackup,
        invoice_sequences: invoiceBackup,
        return_sequences: returnSequenceBackup,
        sales: salesBackup,
        sale_items: itemsBackup,
        returns: returnsBackup,
        loans: loansBackup,
        loan_settlements: settlementsBackup,
        audit_log: auditBackup
      };
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      link.download = `aziz-shop-before-reset-${today()}.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      const { error: resetError } = await supabase.rpc('reset_shop_data', { p_confirmation: resetPhrase });
      if (resetError) throw resetError;

      // Wipe local IndexedDB offline tables so client mirror is completely cleared
      await syncEngine.clearLocalDatabase();

      setProducts([]);
      setSales([]);
      setReturns([]);
      setLoans([]);
      setResetPhrase('');
      setCart([{ productId: '', quantity: '1', unitPrice: '' }]);
      setEditingProduct(null);
      await loadData();
      setMessage('All shop data was reset. A full JSON safety export was downloaded. The admin account remains active.');
    } catch (cause) {
      setError(`Reset did not complete: ${errorText(cause)}`);
    } finally {
      setBusy(false);
    }
  }

  function showPrinterTest() {
    setReceipt({
      kind: 'SALE',
      number: 'PRINTER-TEST',
      date: today(),
      totalLabel: 'TOTAL',
      total: 1475,
      notes: 'Check both paper edges, small text, and the total.',
      items: [
        { name: 'Iranian sweets family box', unit: 'Kg', quantity: 1.5, rate: 150, amount: 225 },
        { name: 'Washing powder carton', unit: 'Box', quantity: 1, rate: 1250, amount: 1250 }
      ]
    });
  }

  function exportReport() {
    if (reportStart > reportEnd) return;
    const saleRows = reportSales.map((sale) => {
      const saleRefunds = returns
        .filter((r) => r.sale_id === sale.id)
        .reduce((sum, r) => sum + r.refund_amount, 0);
      const netBill = Math.max(0, sale.net_total - saleRefunds);
      const saleProfit = sale.items.reduce(
        (sum, item) => sum + item.line_total - item.cost_total_snapshot,
        0
      );
      return [
        sale.invoice_number,
        sale.sale_date,
        String(sale.items.length),
        sale.net_total.toFixed(2),
        saleRefunds.toFixed(2),
        netBill.toFixed(2),
        saleProfit.toFixed(2),
        sale.status
      ];
    });

    const returnSectionRows = reportReturns.map((ret) => [
      ret.bill_number,
      ret.invoice_number || 'Unlinked',
      ret.product_name_snapshot,
      ret.movement_date,
      ret.quantity.toString(),
      ret.refund_amount.toFixed(2),
      ret.restock ? 'Restocked' : 'Damaged / Discarded',
      ret.reason
    ]);

    const rows = [
      ['SALES INVOICES', `Period: ${reportStart} to ${reportEnd}`],
      ['Invoice', 'Date', 'Items Count', 'Original Total (Rs.)', 'Refunds (Rs.)', 'Net Bill (Rs.)', 'Gross Profit (Rs.)', 'Status'],
      ...saleRows,
      [],
      ['CUSTOMER RETURNS', `Period: ${reportStart} to ${reportEnd}`],
      ['Return Bill', 'Original Invoice', 'Product', 'Date', 'Quantity', 'Refund Amount (Rs.)', 'Condition', 'Reason'],
      ...returnSectionRows,
      [],
      ['PERIOD SUMMARY'],
      ['Total Sales (Rs.)', reportSales.filter((s) => s.status === 'CONFIRMED').reduce((sum, s) => sum + s.net_total, 0).toFixed(2)],
      ['Total Customer Refunds (Rs.)', reportReturns.reduce((sum, r) => sum + r.refund_amount, 0).toFixed(2)],
      ['Net Sales (Rs.)', reportNet.toFixed(2)],
      ['Trading Profit (Rs.)', reportProfit.toFixed(2)]
    ];

    const csv = rows
      .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = `Shop_Report_${reportStart}_${reportEnd}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  if (!supabase) return <SetupNotice />;

  if (!session)
    return (
      <main className="auth-screen">
        <div className="auth-aside">
          <div className="brand-mark">
            A<span>&</span>S
          </div>
          <p className="eyebrow">AZIZ & SON / WHOLESALE</p>
          <h1>
            Every item.
            <br />
            Every rupee.
            <br />
            <i>In order.</i>
          </h1>
          <p className="auth-note">
            Stock, sales and shop money, kept together in one clear ledger.
          </p>
          <div className="auth-stamp">
            EST. 1998 <span>•</span> SHOP RECORDS
          </div>
        </div>
        <section className="auth-main">
          <div className="auth-form-wrap">
            <p className="eyebrow">PRIVATE SHOP WORKSPACE</p>
            <h2>Sign in to your shop</h2>
            <p className="muted">Your records are private to your account.</p>
            {error && <Notice kind="error">{error}</Notice>}
            {message && <Notice>{message}</Notice>}
            <form onSubmit={authenticate} className="form-stack">
              <Field label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  placeholder="aziz@gmail.com"
                />
              </Field>
              <Field label="Password">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  autoComplete="current-password"
                />
              </Field>
              <button className="button primary full" disabled={authBusy}>
                {authBusy ? 'Please wait…' : 'Sign in'}
              </button>
            </form>
            <p className="auth-single-user">Single administrator account</p>
          </div>
          <div className="auth-foot">
            AZIZ & SON <span>SECURE CLOUD RECORDS</span>
          </div>
        </section>
      </main>
    );

  const title = navItems.find((item) => item.id === tab)?.label || 'Overview';
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => setTab('overview')}>
          <span className="brand-icon">
            A<span>&</span>S
          </span>
          <span className="brand-copy">
            <b>AZIZ & SON</b>
            <small>WHOLESALE LEDGER</small>
          </span>
        </a>
        <div className="branch-label">
          WORKSPACE <span>01</span>
        </div>
        <nav>
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-link ${tab === id ? 'active' : ''}`}
              onClick={() => setTab(id)}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {id === 'products' && lowStock.length > 0 && (
                <i className="nav-count">{lowStock.length}</i>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={`online-dot ${syncState.isOnline ? '' : 'offline'}`} />
            {syncState.isOnline ? 'CLOUD CONNECTED' : 'OFFLINE MODE'}
          </div>
          <button className="account" onClick={() => void handleSignOut()}>
            <span className="avatar">{session.email?.slice(0, 1).toUpperCase()}</span>
            <span>
              <b>{session.email}</b>
              <small>Sign out</small>
            </span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="crumb">
              SHOP FLOOR <span>/</span> {title.toUpperCase()}
            </p>
            <h1>{tab === 'overview' ? settings.business_name : title}</h1>
          </div>
          <div className="top-actions">
            {/* Real-time Sync Status Indicator */}
            {syncState.isSyncing ? (
              <span className="sync-badge syncing" title="Syncing transactions with cloud database">
                <RefreshCw className="spin" size={13} /> Syncing ({syncState.pendingCount} pending)
              </span>
            ) : !syncState.isOnline ? (
              <span className="sync-badge offline" title="Working offline. All transactions are saved locally on this PC.">
                <WifiOff size={13} /> Offline · {syncState.pendingCount > 0 ? `${syncState.pendingCount} pending sync` : 'Working locally'}
              </span>
            ) : syncState.pendingCount > 0 ? (
              <span className="sync-badge pending" title="Online. Transactions queued for cloud sync.">
                <Clock size={13} /> Online · {syncState.pendingCount} pending sync
              </span>
            ) : (
              <span className="sync-badge online" title="All transactions synchronized with cloud">
                <CheckCircle2 size={13} /> Online · All data synced
              </span>
            )}

            {/* Manual Sync Button */}
            <button
              type="button"
              className="sync-btn"
              onClick={() => void syncEngine.sync().then(() => refreshFromOfflineDb())}
              disabled={syncState.isSyncing}
              title="Synchronize local transactions with cloud now"
            >
              <RefreshCw size={12} className={syncState.isSyncing ? 'spin' : ''} /> Sync Now
            </button>

            <span className="date-chip">
              {new Intl.DateTimeFormat('en', {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
                year: 'numeric'
              }).format(new Date())}
            </span>
            <button
              className="button primary"
              onClick={() => {
                setTab('sales');
                setCart([{ productId: '', quantity: '1', unitPrice: '' }]);
              }}
            >
              <Plus size={16} /> New sale <kbd>F2</kbd>
            </button>
          </div>
        </header>
        <div className="content">
          {error && <Notice kind="error">{error}</Notice>}
          {message && <Notice>{message}</Notice>}
          {loading && (
            <div className="loading-line">
              <span /> Refreshing shop records…
            </div>
          )}
          {tab === 'overview' && (
            <>
              <div className="metric-grid">
                <Metric
                  label="Net sales today"
                  value={formatMoney(todayNetSales)}
                  detail={`${todaySales.length} saved ${todaySales.length === 1 ? 'bill' : 'bills'}`}
                  icon={ShoppingCart}
                  tone="green"
                />
                <Metric
                  label="Customer refunds"
                  value={formatMoney(todayRefunds.reduce((sum, row) => sum + row.refund_amount, 0))}
                  detail={`${todayRefunds.length} return lines today`}
                  icon={Undo2}
                  tone="rust"
                />
                <Metric
                  label="Trading profit"
                  value={formatMoney(todayProfit)}
                  detail="After refunds, before expenses"
                  icon={ChartNoAxesCombined}
                  tone="gold"
                />
                <Metric
                  label="Stock on hand"
                  value={formatMoney(stockValue)}
                  detail={`${products.filter((product) => product.active).length} active products`}
                  icon={Boxes}
                  tone="ink"
                />
              </div>
              <div className="overview-grid">
                <section className="surface span-all">
                  <SectionHead
                    title="Recent bills"
                    eyebrow="SALES BOOK"
                    action={
                      <button className="text-button" onClick={() => setTab('sales')}>
                        Full sales book <ArrowLeftRight size={14} />
                      </button>
                    }
                  />
                  <SalesTable sales={sales.slice(0, 10)} returns={returns} onPrint={(sale) => setReceipt(saleReceipt(sale))} />
                </section>
              </div>
              <div className="bottom-grid">
                <section className="surface span-all">
                  <SectionHead
                    title="Latest returns"
                    eyebrow="RETURNS BOOK"
                    action={
                      <button className="text-button" onClick={() => setTab('returns')}>
                        Open returns <ArrowLeftRight size={14} />
                      </button>
                    }
                  />
                  {returns.slice(0, 6).map((row) => (
                    <div className="ledger-row" key={row.id}>
                      <div className="ledger-icon rust">
                        <Undo2 size={15} />
                      </div>
                      <div>
                        <b>{row.bill_number}</b>
                        <small>
                          {row.product_name_snapshot} · {row.movement_date}
                        </small>
                      </div>
                      <strong className="negative">−{formatMoney(row.refund_amount)}</strong>
                    </div>
                  ))}
                  {!returns.length && <EmptyState text="No customer returns have been recorded." />}
                </section>
              </div>
            </>
          )}
          {tab === 'sales' && (
            <div className="page-grid">
              <section className="surface form-surface span-all">
                <SectionHead title="Write a sales bill" eyebrow="NEW TRANSACTION" />
                <p className="section-copy">
                  Prices and cost are recorded in the bill when it is saved. Stock is verified in real-time.
                </p>
                {(() => {
                  const hasOversell = cart.some((line) => {
                    if (!line.productId) return false;
                    const p = products.find((candidate) => candidate.id === line.productId);
                    return p && (Number(line.quantity) > p.stock || p.stock <= 0);
                  });
                  return (
                    <form onSubmit={createSale} className="form-stack">
                      <div className="form-row">
                        <Field label="Customer name (optional)">
                          <input
                            placeholder="e.g. Walk-in customer or shop name"
                            value={saleCustomerName}
                            onChange={(event) => setSaleCustomerName(event.target.value)}
                          />
                        </Field>
                        <Field label="Customer mobile (11 digits, optional)">
                          <input
                            type="tel"
                            maxLength={11}
                            placeholder="03001234567 (11 digits)"
                            value={saleCustomerPhone}
                            onChange={(event) =>
                              setSaleCustomerPhone(event.target.value.replace(/\D/g, '').slice(0, 11))
                            }
                          />
                        </Field>
                      </div>

                      <div className="pos-bill-table-wrap">
                        <div className="pos-table-header">
                          <span style={{ textAlign: 'center' }}>#</span>
                          <span>Product</span>
                          <span style={{ textAlign: 'center' }}>Available</span>
                          <span style={{ textAlign: 'center' }}>Quantity</span>
                          <span>Rate (Rs.)</span>
                          <span style={{ textAlign: 'right' }}>Line Total</span>
                          <span></span>
                        </div>

                        <div className="pos-bill-table">
                          {cart.map((line, index) => {
                            const product = products.find((item) => item.id === line.productId);
                            const qtyNum = Number(line.quantity) || 0;
                            const isOverselling = Boolean(product && qtyNum > product.stock);
                            const isOutOfStock = Boolean(product && product.stock <= 0);
                            const isLowStock = Boolean(product && product.stock > 0 && product.stock <= product.minimum_stock);
                            const lineTotal = product
                              ? lineAmount(
                                  qtyNum,
                                  Number(line.unitPrice || product.sale_price)
                                )
                              : 0;

                            return (
                              <div
                                key={index}
                                className={`pos-table-row ${isOverselling || isOutOfStock ? 'oversell' : ''}`}
                              >
                                <span className="pos-col-idx">{index + 1}</span>

                                <div className="pos-col-prod">
                                  <SearchableProductSelect
                                    products={activeProducts}
                                    value={line.productId}
                                    placeholder="Search product..."
                                    onChange={(newProductId) => {
                                      const selected = products.find((entry) => entry.id === newProductId);
                                      setCart(
                                        cart.map((item, itemIndex) =>
                                          itemIndex === index
                                            ? {
                                                ...item,
                                                productId: newProductId,
                                                unitPrice: selected ? selected.sale_price.toFixed(2) : ''
                                              }
                                            : item
                                        )
                                      );
                                    }}
                                  />
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'center' }}>
                                  {!product ? (
                                    <span className="pos-stock-badge none">—</span>
                                  ) : product.stock <= 0 ? (
                                    <span className="pos-stock-badge out">0 {product.unit} (Out)</span>
                                  ) : isLowStock ? (
                                    <span className="pos-stock-badge low" title="Low stock warning">
                                      {formatQuantity(product.stock)} {product.unit}
                                    </span>
                                  ) : (
                                    <span className="pos-stock-badge ok">
                                      {formatQuantity(product.stock)} {product.unit}
                                    </span>
                                  )}
                                </div>

                                <div>
                                  <div className="pos-qty-group">
                                    <button
                                      type="button"
                                      title="Decrease quantity"
                                      disabled={qtyNum <= 1}
                                      onClick={() => {
                                        const next = Math.max(1, qtyNum - 1);
                                        setCart(
                                          cart.map((item, i) =>
                                            i === index ? { ...item, quantity: String(next) } : item
                                          )
                                        );
                                      }}
                                    >
                                      −
                                    </button>
                                    <input
                                      type="number"
                                      min="0.001"
                                      step="any"
                                      value={line.quantity}
                                      onChange={(event) =>
                                        setCart(
                                          cart.map((item, itemIndex) =>
                                            itemIndex === index
                                              ? { ...item, quantity: event.target.value }
                                              : item
                                          )
                                        )
                                      }
                                    />
                                    <button
                                      type="button"
                                      title="Increase quantity"
                                      disabled={product ? qtyNum >= product.stock : false}
                                      onClick={() => {
                                        const next = qtyNum + 1;
                                        setCart(
                                          cart.map((item, i) =>
                                            i === index ? { ...item, quantity: String(next) } : item
                                          )
                                        );
                                      }}
                                    >
                                      +
                                    </button>
                                  </div>
                                </div>

                                <div>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    className="pos-price-input"
                                    value={line.unitPrice}
                                    onChange={(event) =>
                                      setCart(
                                        cart.map((item, itemIndex) =>
                                          itemIndex === index
                                            ? { ...item, unitPrice: event.target.value }
                                            : item
                                        )
                                      )
                                    }
                                  />
                                </div>

                                <div className="pos-total-cell">
                                  {formatMoney(lineTotal)}
                                </div>

                                <div>
                                  <button
                                    type="button"
                                    className="pos-del-btn"
                                    title="Remove item"
                                    disabled={cart.length === 1}
                                    onClick={() =>
                                      setCart(cart.filter((_item, itemIndex) => itemIndex !== index))
                                    }
                                  >
                                    <X size={15} />
                                  </button>
                                </div>

                                {isOverselling && product && product.stock > 0 && (
                                  <div className="pos-row-warning">
                                    <span>
                                      ⛔ Exceeds available stock! Only {formatQuantity(product.stock)} {product.unit} available in store.
                                    </span>
                                    <button
                                      type="button"
                                      className="quick-set-btn"
                                      onClick={() =>
                                        setCart(
                                          cart.map((item, i) =>
                                            i === index ? { ...item, quantity: String(product.stock) } : item
                                          )
                                        )
                                      }
                                    >
                                      ⚡ Set to max ({formatQuantity(product.stock)} {product.unit})
                                    </button>
                                  </div>
                                )}

                                {isOutOfStock && product && (
                                  <div className="pos-row-warning">
                                    <span>
                                      🚫 Product is completely out of stock (0 {product.unit}). Please select another item or restock.
                                    </span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                        <button
                          type="button"
                          className="text-button add-line"
                          onClick={() =>
                            setCart([...cart, { productId: '', quantity: '1', unitPrice: '' }])
                          }
                        >
                          <Plus size={15} /> Add another item
                        </button>
                      </div>

                      <div className="bill-total">
                        <span>Bill total</span>
                        <strong>
                          {formatMoney(
                            cart.reduce((sum, line) => {
                              const product = products.find((item) => item.id === line.productId);
                              return (
                                sum +
                                (product
                                  ? lineAmount(
                                      Number(line.quantity) || 0,
                                      Number(line.unitPrice || product.sale_price)
                                    )
                                  : 0)
                              );
                            }, 0)
                          )}
                        </strong>
                      </div>

                      {hasOversell && (
                        <div className="oversell-banner">
                          <AlertTriangle size={20} />
                          <div>
                            <strong>STOP: Quantity exceeds available stock!</strong>
                            <p>
                              One or more items in this bill have a quantity greater than shelf stock.
                              Reduce the quantity or click &ldquo;Set to max&rdquo; to complete the sale.
                            </p>
                          </div>
                        </div>
                      )}

                      <button
                        className="button primary"
                        disabled={busy || !activeProducts.length || hasOversell || cart.every((l) => !l.productId)}
                        title={hasOversell ? 'Cannot save: Stock exceeded' : 'Save and print bill'}
                      >
                        <ShoppingCart size={16} />
                        {hasOversell ? '⛔ Cannot Save (Stock Exceeded)' : 'Save & Print bill'}
                      </button>
                    </form>
                  );
                })()}
              </section>
              <section className="surface span-all">
                <SectionHead title="Sales book" eyebrow="LATEST 300 BILLS" />
                <SalesTable sales={sales} returns={returns} onPrint={(sale) => setReceipt(saleReceipt(sale))} />
              </section>
            </div>
          )}
          {tab === 'products' && (
            <div className="page-grid">
              <section id="product-form" className="surface form-surface span-all">
                <SectionHead title={editingProduct ? 'Edit product' : 'Add a product'} eyebrow="PRODUCT CATALOG" />
                <form className="form-stack" onSubmit={createProduct}>
                  <Field label="Product name">
                    <input
                      value={newProduct.name}
                      onChange={(event) =>
                        setNewProduct({ ...newProduct, name: event.target.value })
                      }
                      required
                      maxLength={160}
                    />
                  </Field>
                  <div className="form-row">
                    <Field label="Selling unit">
                      <input
                        value={newProduct.unit}
                        onChange={(event) =>
                          setNewProduct({ ...newProduct, unit: event.target.value })
                        }
                        required
                        maxLength={40}
                        disabled={Boolean(editingProduct && editingProduct.stock > 0)}
                        placeholder="e.g. Box"
                      />
                      <div className="unit-chips">
                        {['Box', 'Piece', 'Kg', 'Carton', 'Packet', 'Bag', 'Dozen', 'Roll'].map((u) => (
                          <button
                            key={u}
                            type="button"
                            className={`unit-chip ${newProduct.unit.toLowerCase() === u.toLowerCase() ? 'active' : ''}`}
                            onClick={() => setNewProduct({ ...newProduct, unit: u })}
                            disabled={Boolean(editingProduct && editingProduct.stock > 0)}
                          >
                            {u}
                          </button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Minimum stock">
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        value={newProduct.minimum_stock}
                        onChange={(event) =>
                          setNewProduct({ ...newProduct, minimum_stock: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                  <div className="form-row">
                    <Field label="Buying rate (Rs.)">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={newProduct.purchase_cost}
                        onChange={(event) =>
                          setNewProduct({ ...newProduct, purchase_cost: event.target.value })
                        }
                        required
                        disabled={Boolean(editingProduct && editingProduct.stock > 0)}
                      />
                    </Field>
                    <Field label="Selling rate (Rs.)">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={newProduct.sale_price}
                        onChange={(event) =>
                          setNewProduct({ ...newProduct, sale_price: event.target.value })
                        }
                        required
                      />
                    </Field>
                  </div>
                  {!editingProduct && (
                    <Field label="Starting shelf stock (optional - saves in 1 step)">
                      <input
                        type="number"
                        min="0"
                        step="0.001"
                        placeholder="e.g. 50 (Instant stock on hand so you can sell right away)"
                        value={newProduct.opening_stock}
                        onChange={(event) => setNewProduct({ ...newProduct, opening_stock: event.target.value })}
                      />
                    </Field>
                  )}
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <button className="button primary" disabled={busy}>
                      {editingProduct ? <Pencil size={16} /> : <Plus size={16} />}
                      {editingProduct ? 'Save changes' : 'Save product'}
                    </button>
                    {editingProduct && (
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => {
                          setEditingProduct(null);
                          setNewProduct({
                            name: '',
                            unit: 'Box',
                            purchase_cost: '',
                            sale_price: '',
                            minimum_stock: '10',
                            opening_stock: ''
                          });
                        }}
                      >
                        Cancel edit
                      </button>
                    )}
                  </div>
                </form>
              </section>
              <section className="surface span-all">
                <div className="section-head">
                  <div>
                    <p className="eyebrow">{products.length} PRODUCTS</p>
                    <h2>Product list</h2>
                  </div>
                  <label className="search-field">
                    <Search size={15} />
                    <input
                      placeholder="Find a product"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </label>
                  <select className="compact-select" aria-label="Filter products" value={productFilter} onChange={(event) => setProductFilter(event.target.value as typeof productFilter)}>
                    <option value="ALL">All products</option>
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="LOW_STOCK">Low stock</option>
                  </select>
                </div>
                <ProductsTable products={visibleProducts} onEdit={beginEditProduct} onToggleActive={toggleProductActive} onQuickStock={openQuickStock} />
              </section>
            </div>
          )}
          {tab === 'returns' && (
            <div className="page-grid">
              <section className="surface form-surface span-all">
                <SectionHead title="Record a return" eyebrow="CUSTOMER REFUND" />
                <form onSubmit={createReturn} className="form-stack">
                  <Field label="Original sales bill (optional)">
                    <select
                      value={returnForm.saleId}
                      onChange={(event) =>
                        setReturnForm({
                          ...returnForm,
                          saleId: event.target.value,
                          productId: '',
                          quantity: '',
                          refund: ''
                        })
                      }
                    >
                      <option value="">No original bill (Direct return)</option>
                      {returnSales.map((sale) => (
                        <option key={sale.id} value={sale.id}>
                          {sale.invoice_number} · {sale.sale_date} · {sale.customer_name ? `${sale.customer_name} · ` : ''}{formatMoney(sale.net_total)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {returnForm.saleId ? (
                    <Field label="Returned product">
                      <select
                        value={returnForm.productId}
                        onChange={(event) =>
                          setReturnForm({
                            ...returnForm,
                            productId: event.target.value,
                            quantity: ''
                          })
                        }
                      >
                        <option value="">Choose invoice item</option>
                        {selectedReturnSale?.items.map((item) => {
                          const returnedQty = returns
                            .filter(
                              (row) =>
                                row.sale_id === returnForm.saleId &&
                                row.product_id === item.product_id
                            )
                            .reduce((sum, row) => sum + row.quantity, 0);
                          const remaining = Math.max(0, item.quantity - returnedQty);
                          return (
                            <option
                              key={item.product_id}
                              value={item.product_id}
                              disabled={!remaining}
                            >
                              {item.product_name_snapshot} · {formatQuantity(remaining)}{' '}
                              {item.unit_snapshot} left
                            </option>
                          );
                        })}
                      </select>
                    </Field>
                  ) : (
                    <>
                      <Field label="Product">
                        <SearchableProductSelect
                          products={products}
                          value={returnForm.productId}
                          onChange={(id) =>
                            setReturnForm({ ...returnForm, productId: id })
                          }
                          placeholder="Search product for return..."
                          required
                        />
                      </Field>
                      <Field label="Refund amount (Rs.)">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={returnForm.refund}
                          onChange={(event) =>
                            setReturnForm({ ...returnForm, refund: event.target.value })
                          }
                          required
                        />
                      </Field>
                    </>
                  )}
                  <div className="form-row">
                    <Field label="Quantity">
                      <input
                        type="number"
                        min="0.001"
                        step="0.001"
                        value={returnForm.quantity}
                        onChange={(event) =>
                          setReturnForm({ ...returnForm, quantity: event.target.value })
                        }
                        required
                      />
                    </Field>
                    <Field label="Return date">
                      <input
                        type="date"
                        value={returnForm.date}
                        min={selectedReturnSale ? selectedReturnSale.sale_date : undefined}
                        onChange={(event) =>
                          setReturnForm({ ...returnForm, date: event.target.value })
                        }
                        required
                      />
                    </Field>
                  </div>
                  <Field label="Reason">
                    <input
                      value={returnForm.reason}
                      onChange={(event) =>
                        setReturnForm({ ...returnForm, reason: event.target.value })
                      }
                      required
                    />
                  </Field>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={returnForm.restock}
                      onChange={(event) =>
                        setReturnForm({ ...returnForm, restock: event.target.checked })
                      }
                    />
                    <span>Saleable, add returned goods back to stock</span>
                  </label>
                  {selectedReturnItem && (
                    <div className="refund-preview">
                      <span>Estimated refund</span>
                      <b>
                        {formatMoney(
                          lineAmount(
                            Number(returnForm.quantity) || 0,
                            selectedReturnItem.unit_price
                          )
                        )}
                      </b>
                      <small>
                        Final partial return uses any remaining invoice rounding amount.
                      </small>
                    </div>
                  )}
                  <button className="button primary" disabled={busy}>
                    <Undo2 size={16} /> Save return
                  </button>
                </form>
              </section>
              <section className="surface span-all">
                <SectionHead title="Return book" eyebrow={`${returns.length} RETURN LINES`} />
                {returns.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Return bill</th>
                          <th>Original invoice</th>
                          <th>Product</th>
                          <th>Date</th>
                          <th>Condition</th>
                          <th className="align-right">Refund</th>
                          <th>Receipt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {returns.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <b>{row.bill_number}</b>
                            </td>
                            <td>{row.invoice_number || 'Unlinked'}</td>
                            <td>
                              {row.product_name_snapshot}
                              <small>
                                {formatQuantity(row.quantity)} {row.unit_snapshot}
                              </small>
                            </td>
                            <td>{row.movement_date}</td>
                            <td>
                              <span className={`pill ${row.restock ? 'pill-green' : 'pill-rust'}`}>
                                {row.restock ? 'Restocked' : 'Damaged'}
                              </span>
                            </td>
                            <td className="align-right numeric">
                              {formatMoney(row.refund_amount)}
                            </td>
                            <td>
                              <button className="icon-button" type="button" title={`Print ${row.bill_number}`} aria-label={`Print ${row.bill_number}`} onClick={() => setReceipt(savedReturnReceipt(row, returns, sales))}>
                                <Printer size={15} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState text="Saved customer returns will appear here." />
                )}
              </section>
            </div>
          )}
          {tab === 'money' && (
            <div className="page-grid">
              <section className="surface form-surface">
                <SectionHead title="Record money" eyebrow="GIVEN / TAKEN" />
                <form onSubmit={createLoan} className="form-stack">
                  <Field label="Person or party">
                    <input
                      value={loanForm.person}
                      onChange={(event) => setLoanForm({ ...loanForm, person: event.target.value })}
                      required
                    />
                  </Field>
                  <div className="form-row">
                    <Field label="Direction">
                      <select
                        value={loanForm.type}
                        onChange={(event) =>
                          setLoanForm({
                            ...loanForm,
                            type: event.target.value as 'GIVEN' | 'TAKEN'
                          })
                        }
                      >
                        <option value="GIVEN">Given · to receive</option>
                        <option value="TAKEN">Taken · to pay</option>
                      </select>
                    </Field>
                    <Field label="Amount (Rs.)">
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={loanForm.amount}
                        onChange={(event) =>
                          setLoanForm({ ...loanForm, amount: event.target.value })
                        }
                        required
                      />
                    </Field>
                  </div>
                  <Field label="Date">
                    <input
                      type="date"
                      value={loanForm.date}
                      onChange={(event) => setLoanForm({ ...loanForm, date: event.target.value })}
                      required
                    />
                  </Field>
                  <button className="button primary" disabled={busy}>
                    <Plus size={16} /> Save money record
                  </button>
                </form>
                <div className="form-divider" />
                <SectionHead title="Record repayment" eyebrow="RECEIVE / PAY BACK" />
                <form onSubmit={settleLoan} className="form-stack">
                  <Field label="Open balance">
                    <select
                      value={settlement.loanId}
                      onChange={(event) =>
                        setSettlement({ ...settlement, loanId: event.target.value })
                      }
                      required
                    >
                      <option value="">Choose a balance</option>
                      {loans
                        .filter((loan) => loan.remaining_amount > 0)
                        .map((loan) => (
                          <option key={loan.id} value={loan.id}>
                            {loan.person_name} · {loan.type === 'GIVEN' ? 'to receive' : 'to pay'} ·{' '}
                            {formatMoney(loan.remaining_amount)}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <div className="form-row">
                    <Field label="Amount (Rs.)">
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        value={settlement.amount}
                        onChange={(event) =>
                          setSettlement({ ...settlement, amount: event.target.value })
                        }
                        required
                      />
                    </Field>
                    <Field label="Date">
                      <input
                        type="date"
                        value={settlement.date}
                        onChange={(event) =>
                          setSettlement({ ...settlement, date: event.target.value })
                        }
                        required
                      />
                    </Field>
                  </div>
                  <button
                    className="button secondary"
                    disabled={busy || !loans.some((loan) => loan.remaining_amount > 0)}
                  >
                    <ArrowDownToLine size={16} /> Save repayment
                  </button>
                </form>
              </section>
              <section className="money-summary">
                <Metric
                  label="Still to receive"
                  value={formatMoney(outstandingIn)}
                  detail="Money given to others"
                  icon={ArrowDownToLine}
                  tone="green"
                />
                <Metric
                  label="Still to pay"
                  value={formatMoney(outstandingOut)}
                  detail="Money taken from others"
                  icon={ArrowLeftRight}
                  tone="rust"
                />
              </section>
              <section className="surface span-all">
                <SectionHead title="Money ledger" eyebrow={`${loans.length} RECORDS`} />
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Person</th>
                        <th>Direction</th>
                        <th>Date</th>
                        <th className="align-right">Original</th>
                        <th className="align-right">Repaid</th>
                        <th className="align-right">Remaining</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loans.map((loan) => (
                        <tr key={loan.id}>
                          <td>
                            <b>{loan.person_name}</b>
                          </td>
                          <td>{loan.type === 'GIVEN' ? 'To receive' : 'To pay'}</td>
                          <td>{loan.loan_date}</td>
                          <td className="align-right numeric">{formatMoney(loan.amount)}</td>
                          <td className="align-right numeric">{formatMoney(loan.paid_amount)}</td>
                          <td className="align-right numeric">
                            {formatMoney(loan.remaining_amount)}
                          </td>
                          <td>
                            <span
                              className={`pill ${loan.status === 'SETTLED' ? 'pill-green' : 'pill-gold'}`}
                            >
                              {loan.status === 'SETTLED' ? 'Settled' : 'Open'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
          {tab === 'reports' && (
            <>
              <div className="report-toolbar surface">
                <div>
                  <p className="eyebrow">SHOP PERFORMANCE</p>
                  <h2>Reports</h2>
                </div>
                <div className="report-filters">
                  <Field label="From">
                    <input
                      type="date"
                      value={reportStart}
                      onChange={(event) => setReportStart(event.target.value)}
                    />
                  </Field>
                  <Field label="To">
                    <input
                      type="date"
                      value={reportEnd}
                      onChange={(event) => setReportEnd(event.target.value)}
                    />
                  </Field>
                  <button className="button secondary" onClick={exportReport}>
                    <ArrowDownToLine size={15} /> Export CSV
                  </button>
                </div>
              </div>
              {reportStart > reportEnd && (
                <Notice kind="error">From date must be on or before To date.</Notice>
              )}
              <div className="metric-grid report-metrics">
                <Metric
                  label="Bills"
                  value={String(reportSales.filter((sale) => sale.status === 'CONFIRMED').length)}
                  detail={`${reportStart} to ${reportEnd}`}
                  icon={FileText}
                  tone="ink"
                />
                <Metric
                  label="Net sales"
                  value={formatMoney(reportNet)}
                  detail="Refunds use their own event date"
                  icon={ShoppingCart}
                  tone="green"
                />
                <Metric
                  label="Refund total"
                  value={formatMoney(
                    reportReturns.reduce((sum, row) => sum + row.refund_amount, 0)
                  )}
                  detail={`${reportReturns.length} return lines`}
                  icon={Undo2}
                  tone="rust"
                />
                <Metric
                  label="Trading profit"
                  value={formatMoney(reportProfit)}
                  detail="Before shop expenses"
                  icon={ChartNoAxesCombined}
                  tone="gold"
                />
              </div>
              <div className="surface report-table">
                <SectionHead
                  title="Sales activity"
                  eyebrow="SAVED INVOICES IN SELECTED PERIOD"
                  action={
                    <label className="search-field">
                      <Search size={15} />
                      <input
                        placeholder="Filter bill no."
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </label>
                  }
                />
                <SalesTable
                  sales={reportSales.filter((sale) =>
                    sale.invoice_number.toLowerCase().includes(search.toLowerCase())
                  )}
                  returns={returns}
                  onPrint={(sale) => setReceipt(saleReceipt(sale))}
                />
              </div>
              <p className="report-caveat">
                <CircleAlert size={15} /> Trading profit excludes rent, wages, and other operating
                expenses.
              </p>
            </>
          )}
          {tab === 'settings' && (
            <div className="page-grid">
              <section className="surface form-surface">
                <SectionHead title="Admin sign-in" eyebrow="SINGLE ACCOUNT" />
                <p className="section-copy">
                  Only the signed-in administrator can change these credentials. Email changes require inbox confirmation.
                </p>
                <form onSubmit={updateCredentials} className="form-stack">
                  <Field label="Login email">
                    <input type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} required autoComplete="email" />
                  </Field>
                  <Field label="New password">
                    <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} autoComplete="new-password" placeholder="Leave blank to keep current password" />
                  </Field>
                  <Field label="Confirm new password">
                    <input type="password" value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} minLength={8} autoComplete="new-password" />
                  </Field>
                  <button className="button secondary" disabled={busy}><Settings2 size={15} /> Update admin sign-in</button>
                </form>
              </section>
              <section className="surface form-surface">
                <SectionHead title="Shop identity" eyebrow="RECEIPT & WORKSPACE" />
                <form onSubmit={saveSettings} className="form-stack">
                  <Field label="Business name">
                    <input
                      value={businessForm.business_name}
                      onChange={(event) =>
                        setBusinessForm({ ...businessForm, business_name: event.target.value })
                      }
                      required
                    />
                  </Field>
                  <Field label="Address">
                    <input
                      value={businessForm.address}
                      onChange={(event) =>
                        setBusinessForm({ ...businessForm, address: event.target.value })
                      }
                    />
                  </Field>
                  <div className="form-row">
                    <Field label="Phone 1">
                      <input
                        value={businessForm.phone1}
                        onChange={(event) =>
                          setBusinessForm({ ...businessForm, phone1: event.target.value })
                        }
                      />
                    </Field>
                    <Field label="Phone 2">
                      <input
                        value={businessForm.phone2}
                        onChange={(event) =>
                          setBusinessForm({ ...businessForm, phone2: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                  <Field label="Receipt footer">
                    <input
                      value={businessForm.receipt_footer}
                      onChange={(event) =>
                        setBusinessForm({ ...businessForm, receipt_footer: event.target.value })
                      }
                    />
                  </Field>
                  <button className="button primary" disabled={busy}>
                    <Settings2 size={16} /> Save details
                  </button>
                </form>
              </section>
              <section className="surface form-surface span-all">
                <SectionHead title="Database backups & POS tools" eyebrow="DATA & SYSTEM" />
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '14px 0' }}>
                  <button className="button secondary" type="button" onClick={showPrinterTest}>
                    <Printer size={15} /> Preview 80 mm test receipt
                  </button>
                <button
                  className="button secondary"
                  onClick={() => {
                    const content = JSON.stringify(
                      {
                        exportedAt: new Date().toISOString(),
                        products,
                        sales,
                        returns,
                        loans,
                        settings
                      },
                      null,
                      2
                    );
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(
                      new Blob([content], { type: 'application/json' })
                    );
                    link.download = `aziz-shop-records-${today()}.json`;
                    link.click();
                    URL.revokeObjectURL(link.href);
                  }}
                >
                  <ArrowDownToLine size={15} /> Export records
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={async () => {
                    const [p, s, si, r, ri, im, sq] = await Promise.all([
                      offlineDb.products.toArray(),
                      offlineDb.sales.toArray(),
                      offlineDb.sale_items.toArray(),
                      offlineDb.returns.toArray(),
                      offlineDb.return_items.toArray(),
                      offlineDb.inventory_movements.toArray(),
                      offlineDb.sync_queue.toArray()
                    ]);
                    const content = JSON.stringify(
                      {
                        exportedAt: new Date().toISOString(),
                        shop: 'Aziz & Son Wholesale',
                        version: '1.0-offline-pwa',
                        products: p,
                        sales: s,
                        sale_items: si,
                        returns: r,
                        return_items: ri,
                        inventory_movements: im,
                        sync_queue: sq
                      },
                      null,
                      2
                    );
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(
                      new Blob([content], { type: 'application/json' })
                    );
                    link.download = `aziz-pos-offline-backup-${today()}.json`;
                    link.click();
                    URL.revokeObjectURL(link.href);
                  }}
                >
                  <ArrowDownToLine size={15} /> Export Local POS Database Backup (Offline)
                </button>
                <button
                  className="button secondary"
                  type="button"
                  onClick={async () => {
                    setBusy(true);
                    setError('');
                    try {
                      await syncEngine.clearLocalDatabase();
                      setProducts([]);
                      setSales([]);
                      setReturns([]);
                      setLoans([]);
                      await syncEngine.pullCloudState();
                      await refreshFromOfflineDb();
                      setMessage('Local browser storage cleared and resynced with cloud.');
                    } catch (e) {
                      setError(`Storage purge error: ${errorText(e)}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <RefreshCw size={15} /> Purge Local Offline Cache & Resync
                </button>
                </div>
                <div className="reset-zone">
                  <p className="eyebrow">DESTRUCTIVE ACTION</p>
                  <h3>Reset all shop data</h3>
                  <p>Downloads a full JSON safety export, then deletes products, stock history, sales, returns, money records, business settings, and audit history. The admin login remains.</p>
                  <form onSubmit={resetShopData} className="form-stack">
                    <Field label={'Type "RESET AZIZ SHOP" to confirm'}>
                      <input value={resetPhrase} onChange={(event) => setResetPhrase(event.target.value)} autoComplete="off" spellCheck={false} required />
                    </Field>
                    <button className="button reset-button" disabled={busy || resetPhrase !== 'RESET AZIZ SHOP'}>
                      <X size={15} /> Reset entire shop
                    </button>
                  </form>
                </div>
              </section>
            </div>
          )}
        </div>
        {receipt && (
          <ReceiptPreview
            receipt={receipt}
            settings={settings}
            onClose={() => setReceipt(null)}
          />
        )}
        {quickStockProduct && (
          <div className="modal-overlay" role="dialog" aria-modal="true">
            <div className="modal-dialog">
              <div className="modal-header">
                <h3>+ Quick Restock: {quickStockProduct.name}</h3>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setQuickStockProduct(null)}
                  title="Close"
                >
                  <X size={16} />
                </button>
              </div>
              <form onSubmit={handleQuickStockSubmit}>
                <div className="modal-body form-stack">
                  <p style={{ margin: 0, fontSize: '13px', color: '#4a5568' }}>
                    Current shelf stock: <strong>{formatQuantity(quickStockProduct.stock)} {quickStockProduct.unit}</strong>
                  </p>
                  <Field label={`New quantity received (${quickStockProduct.unit})`}>
                    <input
                      type="number"
                      min="0.001"
                      step="any"
                      autoFocus
                      required
                      placeholder="e.g. 50"
                      value={quickStockQty}
                      onChange={(event) => setQuickStockQty(event.target.value)}
                    />
                  </Field>
                  <Field label="Buying rate per unit (Rs.)">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      value={quickStockCost}
                      onChange={(event) => setQuickStockCost(event.target.value)}
                    />
                  </Field>
                </div>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setQuickStockProduct(null)}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="button primary" disabled={busy || !quickStockQty}>
                    <PackagePlus size={15} /> Save Stock Now
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
        <footer className="workspace-footer">
          <span>AZIZ & SON · SHOP LEDGER</span>
          <span>Amounts in Pakistani rupees · Data syncs to your Supabase project</span>
          <button onClick={() => void loadData()} className="refresh-button">
            <Activity size={13} /> Refresh data
          </button>
        </footer>
      </section>
    </main>
  );
}

function SetupNotice() {
  return (
    <main className="setup-screen">
      <div className="setup-mark">
        A<span>&</span>S
      </div>
      <p className="eyebrow">AZIZ & SON / WEB LEDGER</p>
      <h1>Connect your shop database.</h1>
      <p>
        Add the Supabase project URL and publishable key to{' '}
        <code>Aziz-Factory-Website/.env.local</code>, then run the SQL migration in your Supabase
        SQL editor.
      </p>
      <pre>
        NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
        <br />
        NEXT_PUBLIC_SUPABASE_ANON_KEY=your-publishable-key
      </pre>
      <span>No service-role secret belongs in browser or Vercel public environment variables.</span>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Notice({ children, kind }: { children: React.ReactNode; kind?: 'error' }) {
  return (
    <div
      className={`notice ${kind === 'error' ? 'notice-error' : ''}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {kind === 'error' ? <CircleAlert size={16} /> : <span className="notice-tick">✓</span>}
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Coins;
  tone: string;
}) {
  return (
    <section className="metric-card">
      <div className={`metric-icon ${tone}`}>
        <Icon size={17} strokeWidth={1.8} />
      </div>
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}

function SectionHead({
  title,
  eyebrow,
  action
}: {
  title: string;
  eyebrow: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <ClipboardList size={21} />
      <p>{text}</p>
    </div>
  );
}

function SalesTable({
  sales,
  returns = [],
  onPrint
}: {
  sales: Sale[];
  returns?: ReturnRow[];
  onPrint?: (sale: Sale) => void;
}) {
  return sales.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Date</th>
            <th>Customer</th>
            <th>Items</th>
            <th>Status</th>
            <th className="align-right">Net bill</th>
            <th className="print-column">Receipt</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((sale) => {
            const saleReturns = returns.filter((r) => r.sale_id === sale.id);
            const refundedAmount = saleReturns.reduce((sum, r) => sum + r.refund_amount, 0);
            const netBill = roundMoney(Math.max(0, sale.net_total - refundedAmount));
            const isFullyReturned = refundedAmount >= sale.net_total && sale.net_total > 0;
            const isPartialReturn = refundedAmount > 0 && !isFullyReturned;
            const statusLabel =
              sale.status === 'VOIDED'
                ? 'Cancelled'
                : isFullyReturned
                  ? 'Fully returned'
                  : isPartialReturn
                    ? 'Partial return'
                    : 'Confirmed';
            const statusClass =
              sale.status === 'VOIDED'
                ? 'pill-rust'
                : isFullyReturned
                  ? 'pill-rust'
                  : isPartialReturn
                    ? 'pill-gold'
                    : 'pill-green';

            const saleProfit = roundMoney(
              (sale.items && sale.items.length > 0
                ? sale.items.reduce((sum, item) => sum + (Number(item.line_total) - Number(item.cost_total_snapshot || (item.purchase_cost_snapshot * item.quantity) || 0)), 0)
                : Number(sale.original_profit || 0)) -
              saleReturns.reduce((sum, r) => sum + (r.refund_amount - (r.restock ? (r.cost_amount_snapshot || 0) : 0)), 0)
            );

            return (
              <tr key={sale.id}>
                <td>
                  <b className="invoice-number">{sale.invoice_number}</b>
                </td>
                <td>{sale.sale_date}</td>
                <td>
                  <b>{sale.customer_name || 'Walk-in'}</b>
                  {sale.customer_phone && (
                    <small style={{ display: 'block', color: '#666', fontSize: '11px' }}>
                      {sale.customer_phone}
                    </small>
                  )}
                </td>
                <td>
                  {sale.items.length} {sale.items.length === 1 ? 'line' : 'lines'}
                  <small>
                    {sale.items
                      .slice(0, 2)
                      .map((item) => item.product_name_snapshot)
                      .join(', ')}
                  </small>
                </td>
                <td>
                  <span className={`pill ${statusClass}`}>{statusLabel}</span>
                </td>
                <td className="align-right numeric">
                  <b>{formatMoney(netBill)}</b>
                  {refundedAmount > 0 && (
                    <small style={{ color: 'var(--rust)', display: 'block', fontSize: '10px' }}>
                      −{formatMoney(refundedAmount)} returned
                    </small>
                  )}
                  <small style={{ color: saleProfit >= 0 ? '#10b981' : '#ef4444', display: 'block', fontSize: '10px', marginTop: '2px' }}>
                    Profit: {formatMoney(saleProfit)}
                  </small>
                </td>
                <td className="print-column">
                  {onPrint && (
                    <button
                      className="icon-button"
                      type="button"
                      title={`Print ${sale.invoice_number}`}
                      aria-label={`Print ${sale.invoice_number}`}
                      onClick={() => onPrint(sale)}
                    >
                      <Printer size={15} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : (
    <EmptyState text="Sales bills will appear here after the first sale." />
  );
}

function ProductsTable({
  products,
  onEdit,
  onToggleActive,
  onQuickStock
}: {
  products: Product[];
  onEdit?: (product: Product) => void;
  onToggleActive?: (product: Product) => void;
  onQuickStock?: (product: Product) => void;
}) {
  return products.length ? (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Unit</th>
            <th className="align-right">In stock</th>
            <th className="align-right">Buying rate</th>
            <th className="align-right">Selling rate</th>
            <th>Stock status</th>
            {(onEdit || onToggleActive || onQuickStock) && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {products.map((product) => {
            const state =
              product.stock <= 0 ? 'OUT' : product.stock <= product.minimum_stock ? 'LOW' : 'OK';
            return (
              <tr key={product.id}>
                <td>
                  <b>{product.name}</b>
                  {!product.active && <small>Inactive</small>}
                </td>
                <td>{product.unit}</td>
                <td className="align-right numeric">{formatQuantity(product.stock)}</td>
                <td className="align-right numeric">{formatMoney(product.purchase_cost)}</td>
                <td className="align-right numeric">{formatMoney(product.sale_price)}</td>
                <td>
                  <span
                    className={`pill ${state === 'OK' ? 'pill-green' : state === 'LOW' ? 'pill-gold' : 'pill-rust'}`}
                  >
                    {state === 'OK' ? 'In range' : state === 'LOW' ? 'Low stock' : 'Out of stock'}
                  </span>
                </td>
                {(onEdit || onToggleActive || onQuickStock) && (
                  <td className="product-actions">
                    {onQuickStock && (
                      <button
                        className="button secondary compact-btn"
                        type="button"
                        title={`Add Stock to ${product.name}`}
                        onClick={() => onQuickStock(product)}
                      >
                        <PackagePlus size={13} /> + Stock
                      </button>
                    )}
                    {onEdit && (
                      <button
                        className="icon-button"
                        type="button"
                        title={`Edit ${product.name}`}
                        aria-label={`Edit ${product.name}`}
                        onClick={() => onEdit(product)}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                    {onToggleActive && (
                      <button
                        className="icon-button"
                        type="button"
                        title={product.active ? `Deactivate ${product.name}` : `Activate ${product.name}`}
                        aria-label={product.active ? `Deactivate ${product.name}` : `Activate ${product.name}`}
                        onClick={() => onToggleActive(product)}
                      >
                        <Power size={15} />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : (
    <EmptyState text="Add a product to start tracking your catalog." />
  );
}

function ReceiptPreview({
  receipt,
  settings,
  onClose
}: {
  receipt: ReceiptRecord;
  settings: { business_name: string; address: string; phone1: string; phone2: string; receipt_footer: string };
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [deliveryError, setDeliveryError] = useState('');

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  function deliverReceiptPdf(openForPrint: boolean) {
    setDeliveryError('');
    const pdf = createReceiptPdf(receipt, settings);
    const url = URL.createObjectURL(pdf);
    if (openForPrint) {
      const printWindow = window.open(url, '_blank');
      if (!printWindow) {
        URL.revokeObjectURL(url);
        setDeliveryError('The PDF tab was blocked. Allow pop-ups for this site or choose Save PDF.');
        return;
      }
      printWindow.opener = null;
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = `${receipt.number}.pdf`;
      link.click();
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (!mounted) return null;

  return createPortal((
    <div className="receipt-overlay" role="dialog" aria-modal="true" aria-label="Receipt preview">
      <div className="receipt-controls">
        <div>
          <p className="eyebrow">80 MM THERMAL RECEIPT</p>
          <strong>{receipt.number}</strong>
          <small className="receipt-print-instructions">Formatted for 80 mm thermal roll paper. Print directly with no margins, or download the vector PDF.</small>
        </div>
        <div className="receipt-control-actions">
          <button className="button secondary" type="button" onClick={onClose}>Close</button>
          <button className="button primary" type="button" onClick={() => window.print()}><Printer size={15} /> Print bill (80mm)</button>
          <button className="button secondary" type="button" onClick={() => deliverReceiptPdf(false)}><ArrowDownToLine size={15} /> Save PDF</button>
          <button className="button secondary" type="button" onClick={() => deliverReceiptPdf(true)}>Open PDF</button>
        </div>
      </div>
      {deliveryError && <p className="receipt-delivery-error" role="alert">{deliveryError}</p>}
      <div className="receipt-page">
        <article className="receipt-paper" id="receipt-paper">
          <header className="receipt-heading">
            <strong>{settings.business_name}</strong>
            <b style={{ fontSize: '15px', letterSpacing: '2px', display: 'block', margin: '3px 0' }}>{receipt.kind === 'RETURN' ? 'RETURN' : 'SALE'}</b>
          </header>
          {receipt.kind === 'RETURN' && <div className="receipt-rule" />}
          <div className="receipt-meta"><b>Bill:</b><span>{receipt.number}</span></div>
          <div className="receipt-meta"><b>Date:</b><span>{receipt.date}</span></div>
          <div className="receipt-meta"><b>Customer:</b><span>{receipt.customerName || 'Walk-in'}</span></div>
          <div className="receipt-meta"><b>Mobile:</b><span>{receipt.customerPhone || '—'}</span></div>
          {receipt.reference && <div className="receipt-meta"><b>Original:</b><span>{receipt.reference}</span></div>}
          <div className="receipt-rule" />
          <div className="receipt-grid receipt-grid-head"><b>Item</b><b>Qty</b><b>Rate</b><b>Amount</b></div>
          {receipt.items.map((item, index) => (
            <div className="receipt-item" key={`${item.name}-${index}`}>
              <div className="receipt-grid">
                <strong>{item.name}</strong>
                <span>{formatQuantity(item.quantity)} {item.unit}</span>
                <span>{formatQuantity(item.rate)}</span>
                <b>{formatQuantity(item.amount)}</b>
              </div>
              {item.note && <small>{item.note}</small>}
            </div>
          ))}
          <div className="receipt-total"><b>{receipt.totalLabel}</b><strong>{formatMoney(receipt.total)}</strong></div>
          {receipt.kind === 'RETURN' && receipt.notes && <p className="receipt-notes">{receipt.notes}</p>}
          <footer className="receipt-footer">{settings.receipt_footer || 'Thank you for your business!'}</footer>
        </article>
      </div>
    </div>
  ), document.body);
}
