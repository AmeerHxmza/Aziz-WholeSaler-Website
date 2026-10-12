export const roundMoney = (value: number) =>
  Math.sign(value) *
    (Math.round((Math.abs(value) + Number.EPSILON * Math.abs(value)) * 100) / 100) || 0;

export const roundQuantity = (value: number) => Math.round(value * 1000) / 1000;

export function amount(value: unknown, label = 'Amount'): number {
  const number = Number(value);
  if (
    value === '' ||
    value === null ||
    !Number.isFinite(number) ||
    number < 0 ||
    number > 1_000_000_000
  ) {
    throw new Error(`${label} must be between 0 and 1,000,000,000.`);
  }
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${label} must be a whole number.`);
  }
  return roundMoney(number);
}

export function quantity(value: unknown, allowZero = false): number {
  const number = Number(value);
  if (
    value === '' ||
    value === null ||
    !Number.isFinite(number) ||
    number < 0 ||
    (!allowZero && number === 0) ||
    number > 1_000_000
  ) {
    throw new Error('Enter a valid quantity (up to 1,000,000).');
  }
  if (!Number.isSafeInteger(number)) {
    throw new Error('Quantity must be a whole number.');
  }
  const rounded = roundQuantity(number);
  if (!allowZero && rounded <= 0) throw new Error('Quantity must be greater than zero.');
  return rounded;
}

export function lineAmount(qty: number, rate: number): number {
  if (!Number.isFinite(qty) || !Number.isFinite(rate)) throw new Error('Invalid line amount.');
  const product =
    BigInt(Math.round(Math.abs(qty) * 1000)) * BigInt(Math.round(Math.abs(rate) * 1_000_000));
  const paisa = (product + BigInt(5_000_000)) / BigInt(10_000_000);
  return (Math.sign(qty * rate) * Number(paisa)) / 100;
}

export function averageCost(stock: number, cost: number, added: number, addedCost: number): number {
  if (stock + added <= 0) throw new Error('Average cost needs a positive stock quantity.');
  // Match PostgreSQL NUMERIC half-up rounding without binary floating-point
  // errors at the sixth decimal. Retain legacy quantity precision on imports.
  const existingUnits = BigInt(Math.round(stock * 1000));
  const addedUnits = BigInt(Math.round(added * 1000));
  const totalUnits = existingUnits + addedUnits;
  const totalCost = existingUnits * BigInt(Math.round(cost * 1_000_000))
    + addedUnits * BigInt(Math.round(addedCost * 1_000_000));
  return Number((totalCost + totalUnits / BigInt(2)) / totalUnits) / 1_000_000;
}

export function businessDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  ) {
    throw new Error('Choose a valid date.');
  }
  return value;
}

export function dateRange(start?: string, end?: string): void {
  if (start) businessDate(start);
  if (end) businessDate(end);
  if (start && end && start > end) throw new Error('From date must be on or before To date.');
}

export const formatMoney = (value: number) =>
  `Rs. ${new Intl.NumberFormat('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value)}`;

export const formatQuantity = (value: number) =>
  new Intl.NumberFormat('en-PK', { maximumFractionDigits: 3 }).format(value);
