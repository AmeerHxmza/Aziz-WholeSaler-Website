type Page<T> = { data: T[] | null; error: { message: string } | null };

export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<Page<T>>
): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await fetchPage(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
