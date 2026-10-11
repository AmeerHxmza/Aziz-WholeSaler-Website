import { roundMoney } from './calculations';

export function tradingTotals(
  sales: { total: number; cost: number }[],
  returns: { refund: number; costRestocked: number }[]
) {
  const grossSales = roundMoney(sales.reduce((n, s) => n + s.total, 0));
  const grossCogs = roundMoney(sales.reduce((n, s) => n + s.cost, 0));
  const refunds = roundMoney(returns.reduce((n, r) => n + r.refund, 0));
  const returnedCost = roundMoney(returns.reduce((n, r) => n + r.costRestocked, 0));
  const netSales = roundMoney(grossSales - refunds);
  const cogs = roundMoney(grossCogs - returnedCost);
  return { grossSales, grossCogs, refunds, returnedCost, netSales, cogs, profit: roundMoney(netSales - cogs) };
}
