/**
 * Deterministic demo data.
 *
 * Fixed seed, fixed calendar, injected anomalies — so screenshots, tests and
 * the public demo all show the same store. Never run this against a store with
 * real data; `ims reset` wipes the database first.
 */
import { randomUUID } from 'node:crypto';
import type { Database } from './db/database.js';
import { hashPassword } from './shared/security.js';
import { computeSaleTotals } from './domain/costing.js';

/** Mulberry32: small, fast, and reproducible from a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SkuSpec {
  sku: string;
  name: string;
  unit: string;
  price: number;
  cost: number;
  category: string;
  daily: number;
  weekendLift: number;
  pack: number;
}

const CATALOGUE: SkuSpec[] = [
  { sku: 'RC-1KG', name: 'Rice, 1 kg', unit: 'bag', price: 5800, cost: 4750, category: 'Groceries', daily: 9, weekendLift: 1.5, pack: 10 },
  { sku: 'RC-5KG', name: 'Rice, 5 kg', unit: 'bag', price: 26500, cost: 22400, category: 'Groceries', daily: 2.5, weekendLift: 1.4, pack: 4 },
  { sku: 'SG-1KG', name: 'Sugar, 1 kg', unit: 'pack', price: 6500, cost: 5600, category: 'Groceries', daily: 4, weekendLift: 1.3, pack: 10 },
  { sku: 'CO-1L', name: 'Cooking oil, 1 L', unit: 'bottle', price: 9200, cost: 8100, category: 'Groceries', daily: 3, weekendLift: 1.2, pack: 12 },
  { sku: 'CO-330', name: 'Cooking oil, 330 ml', unit: 'sachet', price: 3200, cost: 2650, category: 'Groceries', daily: 6, weekendLift: 1.3, pack: 24 },
  { sku: 'ND-INST', name: 'Instant noodles', unit: 'pack', price: 1500, cost: 1150, category: 'Groceries', daily: 14, weekendLift: 1.2, pack: 40 },
  { sku: 'CF-3IN1', name: 'Coffee 3-in-1', unit: 'sachet', price: 1200, cost: 900, category: 'Beverages', daily: 18, weekendLift: 1.1, pack: 30 },
  { sku: 'CF-200G', name: 'Coffee jar, 200 g', unit: 'jar', price: 15500, cost: 13200, category: 'Beverages', daily: 0.8, weekendLift: 1.2, pack: 6 },
  { sku: 'SO-500', name: 'Softdrink, 500 ml', unit: 'bottle', price: 3500, cost: 2700, category: 'Beverages', daily: 11, weekendLift: 1.6, pack: 12 },
  { sku: 'WT-1L', name: 'Water, 1 L', unit: 'bottle', price: 2000, cost: 1300, category: 'Beverages', daily: 12, weekendLift: 1.5, pack: 12 },
  { sku: 'ML-1L', name: 'Milk, 1 L', unit: 'carton', price: 8900, cost: 7600, category: 'Beverages', daily: 2.2, weekendLift: 1.3, pack: 12 },
  { sku: 'BR-500', name: 'Bread, 500 g', unit: 'loaf', price: 4500, cost: 3400, category: 'Bakery', daily: 5, weekendLift: 1.4, pack: 1 },
  { sku: 'EG-10', name: 'Eggs, 10 pcs', unit: 'tray', price: 9500, cost: 8200, category: 'Fresh', daily: 3.5, weekendLift: 1.3, pack: 1 },
  { sku: 'EG-30', name: 'Eggs, 30 pcs', unit: 'tray', price: 26000, cost: 23100, category: 'Fresh', daily: 0.9, weekendLift: 1.2, pack: 1 },
  { sku: 'CN-165', name: 'Canned tuna, 165 g', unit: 'can', price: 4200, cost: 3500, category: 'Canned', daily: 4.5, weekendLift: 1.2, pack: 24 },
  { sku: 'CN-SARD', name: 'Canned sardines, 155 g', unit: 'can', price: 2800, cost: 2200, category: 'Canned', daily: 7, weekendLift: 1.3, pack: 50 },
  { sku: 'CN-CORN', name: 'Canned corned beef, 150 g', unit: 'can', price: 5500, cost: 4700, category: 'Canned', daily: 3, weekendLift: 1.2, pack: 24 },
  { sku: 'SP-DSH', name: 'Dishwashing liquid, 250 ml', unit: 'bottle', price: 4800, cost: 3800, category: 'Household', daily: 1.6, weekendLift: 1.1, pack: 12 },
  { sku: 'SP-LDY', name: 'Laundry detergent, 500 g', unit: 'pack', price: 6200, cost: 5100, category: 'Household', daily: 1.4, weekendLift: 1.2, pack: 12 },
  { sku: 'SP-BAR', name: 'Bath soap', unit: 'bar', price: 3300, cost: 2500, category: 'Household', daily: 2.2, weekendLift: 1.1, pack: 24 },
  { sku: 'SP-TSP', name: 'Toothpaste, 100 g', unit: 'tube', price: 5900, cost: 4600, category: 'Household', daily: 1.1, weekendLift: 1.0, pack: 12 },
  { sku: 'PP-DIAP', name: 'Diapers, pack of 20', unit: 'pack', price: 21500, cost: 18600, category: 'Baby', daily: 0.7, weekendLift: 1.2, pack: 4 },
  { sku: 'PP-MLK', name: 'Infant milk, 330 g', unit: 'tin', price: 32500, cost: 28400, category: 'Baby', daily: 0.5, weekendLift: 1.1, pack: 6 },
  { sku: 'MD-BIO', name: 'Alcohol, 250 ml', unit: 'bottle', price: 4200, cost: 3200, category: 'Pharmacy', daily: 1.3, weekendLift: 1.0, pack: 12 },
  { sku: 'MD-PAR', name: 'Paracetamol, 10 tabs', unit: 'strip', price: 1800, cost: 1200, category: 'Pharmacy', daily: 3.4, weekendLift: 1.1, pack: 50 },
  { sku: 'MD-LOZ', name: 'Cough lozenges', unit: 'pack', price: 2500, cost: 1800, category: 'Pharmacy', daily: 0.9, weekendLift: 1.0, pack: 24 },
  { sku: 'SN-CHP', name: 'Potato chips, 60 g', unit: 'pack', price: 3800, cost: 2900, category: 'Snacks', daily: 6.5, weekendLift: 1.5, pack: 24 },
  { sku: 'SN-BSC', name: 'Biscuits, 200 g', unit: 'pack', price: 3200, cost: 2500, category: 'Snacks', daily: 4.2, weekendLift: 1.3, pack: 24 },
  { sku: 'SN-CND', name: 'Candy, assorted', unit: 'jar', price: 1500, cost: 950, category: 'Snacks', daily: 9, weekendLift: 1.4, pack: 48 },
  { sku: 'SN-CHC', name: 'Chocolate bar', unit: 'bar', price: 2500, cost: 1800, category: 'Snacks', daily: 5.5, weekendLift: 1.5, pack: 24 },
  { sku: 'LN-PLD', name: 'Pencil', unit: 'pc', price: 1000, cost: 500, category: 'School supplies', daily: 1.8, weekendLift: 0.7, pack: 12 },
  { sku: 'LN-NBK', name: 'Notebook, 60 leaves', unit: 'pc', price: 2500, cost: 1700, category: 'School supplies', daily: 1.5, weekendLift: 0.8, pack: 10 },
  { sku: 'LN-BIC', name: 'Ballpen, blue', unit: 'pc', price: 1200, cost: 600, category: 'School supplies', daily: 2.4, weekendLift: 0.8, pack: 12 },
  { sku: 'HW-NAIL', name: 'Nails, 250 g', unit: 'pack', price: 3500, cost: 2700, category: 'Hardware', daily: 0.6, weekendLift: 1.3, pack: 20 },
  { sku: 'HW-BULB', name: 'LED bulb, 9 W', unit: 'pc', price: 6500, cost: 4800, category: 'Hardware', daily: 0.8, weekendLift: 1.2, pack: 10 },
  // Slow movers on purpose: these are what the ageing report exists for.
  { sku: 'HW-PNT', name: 'Paint, 1 L (slow)', unit: 'can', price: 28500, cost: 24000, category: 'Hardware', daily: 0.03, weekendLift: 1.0, pack: 4 },
  { sku: 'HN-KIT', name: 'Kitchenware set (slow)', unit: 'set', price: 45000, cost: 38000, category: 'Household', daily: 0.02, weekendLift: 1.0, pack: 2 },
  { sku: 'BY-BAG', name: 'School bag (slow)', unit: 'pc', price: 39000, cost: 31000, category: 'School supplies', daily: 0.02, weekendLift: 1.0, pack: 1 },
];

const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Water', 'Transport', 'Supplies', 'Wages'];

export interface SeedResult {
  storeId: string;
  users: { email: string; password: string; role: string }[];
  products: number;
  sales: number;
  expenses: number;
}

export async function seed(db: Database, options: { days?: number; storeCode?: string } = {}): Promise<SeedResult> {
  const days = options.days ?? 150;
  const random = rng(20260921);

  const existing = await db.query<{ id: string }>('SELECT id FROM store WHERE code = $1', [options.storeCode ?? 'DEMO']);
  if (existing.rows[0]) {
    throw new Error('Demo store already exists. Run `ims reset` to wipe the database first.');
  }

  const store = await db.query<{ id: string }>(
    `INSERT INTO store (code, name, timezone, currency, vat_rate_bp, tax_mode)
     VALUES ($1, $2, 'Asia/Manila', 'PHP', 0, 'EXCLUSIVE') RETURNING id`,
    [options.storeCode ?? 'DEMO', 'Demo Sari-Sari Store'],
  );
  const storeId = store.rows[0]?.id ?? randomUUID();

  const users = [
    { email: 'owner@demo.ims', password: 'Demo!Owner2026', role: 'OWNER', name: 'Dalisay Owner' },
    { email: 'manager@demo.ims', password: 'Demo!Manager2026', role: 'MANAGER', name: 'Miguel Manager' },
    { email: 'cashier@demo.ims', password: 'Demo!Cashier2026', role: 'CASHIER', name: 'Carmen Cashier' },
    { email: 'viewer@demo.ims', password: 'Demo!Viewer2026', role: 'VIEWER', name: 'Victor Viewer' },
  ];
  const userIds: Record<string, string> = {};
  for (const u of users) {
    const inserted = await db.query<{ id: string }>(
      'INSERT INTO app_user (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id',
      [u.email, await hashPassword(u.password), u.name],
    );
    const id = inserted.rows[0]?.id ?? '';
    userIds[u.role] = id;
    await db.query('INSERT INTO role_grant (user_id, store_id, role) VALUES ($1,$2,$3)', [id, storeId, u.role]);
  }

  const categoryIds: Record<string, string> = {};
  for (const name of [...new Set(CATALOGUE.map((c) => c.category))]) {
    const inserted = await db.query<{ id: string }>(
      'INSERT INTO category (store_id, name) VALUES ($1,$2) RETURNING id',
      [storeId, name],
    );
    categoryIds[name] = inserted.rows[0]?.id ?? '';
  }

  const supplierIds: Record<string, string> = {};
  for (const [name, lead] of [['Metro Wholesale', 3], ['Northwind Distributors', 5], ['CDO Fresh Supply', 2]] as const) {
    const inserted = await db.query<{ id: string }>(
      'INSERT INTO supplier (store_id, name, contact, lead_time_days) VALUES ($1,$2,$3,$4) RETURNING id',
      [storeId, name, `purchasing@${name.split(' ')[0]!.toLowerCase()}.ph`, lead],
    );
    supplierIds[name] = inserted.rows[0]?.id ?? '';
  }
  const supplierNames = Object.keys(supplierIds);

  const expenseCategoryIds: Record<string, string> = {};
  for (const name of EXPENSE_CATEGORIES) {
    const inserted = await db.query<{ id: string }>(
      'INSERT INTO expense_category (store_id, name) VALUES ($1,$2) RETURNING id',
      [storeId, name],
    );
    expenseCategoryIds[name] = inserted.rows[0]?.id ?? '';
  }

  // ------------------------------------------------------------- products
  interface ProductRow { id: string; spec: SkuSpec; supplierId: string; onHand: number }
  const products: ProductRow[] = [];
  for (const spec of CATALOGUE) {
    const supplierId = supplierIds[supplierNames[Math.floor(random() * supplierNames.length)]!]!;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO product
         (store_id, category_id, supplier_id, sku, name, barcode, unit, selling_price_cents,
          avg_cost_cents, reorder_point, target_cover_days, pack_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [storeId, categoryIds[spec.category], supplierId, spec.sku, spec.name,
       `4800${String(Math.floor(random() * 9_000_000) + 1_000_000)}`, spec.unit, spec.price, spec.cost,
       Math.max(spec.pack, Math.ceil(spec.daily * 7)), 14, spec.pack],
    );
    products.push({ id: inserted.rows[0]?.id ?? '', spec, supplierId, onHand: 0 });
  }

  // Opening stock: post one purchase per SKU so the ledger and the cost basis
  // start from a real transaction rather than a magic number.
  await db.transaction(async (tx) => {
    for (const product of products) {
      const opening = Math.max(product.spec.pack, Math.ceil(product.spec.daily * 10));
      await tx.query(
        `INSERT INTO stock_movement (product_id, store_id, direction, reason, quantity, unit_cost_cents, reference_type)
         VALUES ($1,$2,'IN','PURCHASE',$3,$4,'opening_balance')`,
        [product.id, storeId, opening, product.spec.cost],
      );
      product.onHand = opening;
    }
  });

  // ---------------------------------------------------------------- sales
  const cashierIds = [userIds['CASHIER']!, userIds['MANAGER']!];
  let salesWritten = 0;
  const year = new Date().getUTCFullYear();

  for (let dayOffset = days; dayOffset >= 0; dayOffset--) {
    const date = new Date(Date.now() - dayOffset * 86_400_000);
    date.setUTCHours(0, 0, 0, 0);
    const weekday = date.getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;
    const isPayday = date.getUTCDate() === 15 || date.getUTCDate() === 30;
    // Roughly 1 in 40 days the store is closed.
    if (random() < 0.025) continue;

    const dayFactor = (isWeekend ? 1.35 : 1) * (isPayday ? 1.25 : 1) * (0.85 + random() * 0.3);
    const transactions = Math.max(4, Math.round(22 * dayFactor));

    for (let t = 0; t < transactions; t++) {
      const lineCount = 1 + Math.floor(random() * 4);
      const chosen = new Map<string, { product: ProductRow; quantity: number }>();
      for (let l = 0; l < lineCount; l++) {
        // Weight the draw by expected demand so fast movers dominate the ledger.
        let pick = products[Math.floor(random() * products.length)]!;
        for (let attempt = 0; attempt < 6; attempt++) {
          const candidate = products[Math.floor(random() * products.length)]!;
          if (candidate.spec.daily >= pick.spec.daily) pick = candidate;
        }
        if (random() > pick.spec.daily / 12) continue;
        if (chosen.has(pick.id)) continue;
        chosen.set(pick.id, { product: pick, quantity: 1 + Math.floor(random() * 3) });
      }
      if (chosen.size === 0) continue;

      const lines = [...chosen.values()].map(({ product, quantity }) => ({
        productId: product.id,
        sku: product.spec.sku,
        quantity,
        unitPriceCents: product.spec.price,
        unitCostCents: product.spec.cost,
        // Inject a full line discount now and then: keying errors are real.
        discountCents: random() < 0.01 ? product.spec.price * 1 : 0,
      }));

      const totals = computeSaleTotals({ lines, vatRateBp: 0, taxMode: 'EXCLUSIVE' });
      const occurredAt = new Date(date.getTime() + (8 + Math.floor(random() * 12)) * 3_600_000);
      const reference = `S-${year}-${String(salesWritten + 1).padStart(6, '0')}`;
      const cashierId = cashierIds[Math.floor(random() * cashierIds.length)]!;

      await db.transaction(async (tx) => {
        const sale = await tx.query<{ id: string }>(
          `INSERT INTO sale (store_id, cashier_id, reference, occurred_at, subtotal_cents, discount_cents,
                             net_revenue_cents, tax_cents, total_cents, gross_profit_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [storeId, cashierId, reference, occurredAt, totals.subtotalCents, totals.discountCents,
           totals.netRevenueCents, totals.taxCents, totals.totalCents, totals.grossProfitCents],
        );
        const saleId = sale.rows[0]?.id ?? '';

        for (const [i, line] of totals.lines.entries()) {
          const source = lines[i]!;
          const item = await tx.query<{ id: string }>(
            `INSERT INTO sale_item (sale_id, product_id, quantity, unit_price_cents, unit_cost_cents,
                                    discount_cents, gross_profit_cents)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [saleId, source.productId, line.quantity, line.unitPriceCents, line.unitCostCents,
             line.discountCents, line.grossProfitCents],
          );
          await tx.query(
            `INSERT INTO stock_movement (product_id, store_id, direction, reason, quantity, unit_cost_cents,
                                         reference_type, reference_id, actor_id, created_at)
             VALUES ($1,$2,'OUT','SALE',$3,$4,'sale_item',$5,$6,$7)`,
            [source.productId, storeId, line.quantity, line.unitCostCents, item.rows[0]?.id ?? null,
             cashierId, occurredAt],
          );
          const entry = chosen.get(source.productId);
          if (entry) entry.product.onHand -= line.quantity;
        }

        await tx.query(
          `INSERT INTO payment (sale_id, method, amount_cents)
           VALUES ($1, ${random() < 0.8 ? `'CASH'` : `'EWALLET'`}, $2)`,
          [saleId, totals.totalCents],
        );
      });
      salesWritten++;
    }

    // Restock fast movers every few days so the store does not run to zero.
    if (dayOffset % 4 === 0) {
      for (const product of products) {
        if (product.onHand > product.spec.daily * 3) continue;
        const qty = Math.max(product.spec.pack, Math.ceil(product.spec.daily * 8));
        // Occasionally the supplier raises prices: this is what cost creep looks like.
        const drift = random() < 0.08 ? 1 + Math.round(random() * 18) / 100 : 1;
        const unitCost = Math.round((product.spec.cost * drift) / 10) * 10;
        await db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO stock_movement (product_id, store_id, direction, reason, quantity, unit_cost_cents,
                                         reference_type, created_at)
             VALUES ($1,$2,'IN','PURCHASE',$3,$4,'restock',$5)`,
            [product.id, storeId, qty, unitCost, new Date(date.getTime() + 6 * 3_600_000)],
          );
          product.onHand += qty;
        });
      }
    }
  }

  // Shrinkage: a couple of unexplained write-downs for the anomaly screen to find.
  for (const product of products.slice(0, 2)) {
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO stock_movement (product_id, store_id, direction, reason, quantity, unit_cost_cents,
                                     actor_id, note, created_at)
         VALUES ($1,$2,'OUT','SPOILAGE',$3,$4,$5,'Damaged in storage', now() - interval '6 days')`,
        [product.id, storeId, Math.max(4, Math.ceil(product.spec.daily * 2)), product.spec.cost, userIds['CASHIER']],
      );
    });
  }

  // Rebuild the on-hand cache from the ledger. The ledger is the only source of
  // truth, so the seed cannot drift from invariant #1 by construction.
  await db.exec(`
    INSERT INTO stock_level (product_id, store_id, on_hand, updated_at)
    SELECT product_id, store_id,
           sum(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END)::int,
           now()
      FROM stock_movement GROUP BY product_id, store_id
    ON CONFLICT (product_id, store_id)
    DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()`);
  await db.exec(`
    UPDATE product p SET avg_cost_cents = m.avg_cost
      FROM (SELECT product_id,
                   round(sum(quantity * unit_cost_cents)::numeric / nullif(sum(quantity), 0))::int AS avg_cost
              FROM stock_movement WHERE reason = 'PURCHASE' GROUP BY product_id) m
     WHERE m.product_id = p.id AND coalesce(m.avg_cost, 0) > 0`);

  // ------------------------------------------------------------- expenses
  let expenseCount = 0;
  // Centavos per month. Calibrated so the demo store is profitable but thin —
  // a shop that always loses money tells you nothing about the reports.
  const monthly: Record<string, number> = {
    Rent: 400000, Electricity: 150000, Water: 40000, Transport: 60000, Supplies: 25000, Wages: 250000,
  };
  for (let dayOffset = days; dayOffset >= 0; dayOffset--) {
    const date = new Date(Date.now() - dayOffset * 86_400_000);
    date.setUTCHours(0, 0, 0, 0);
    for (const [name, cents] of Object.entries(monthly)) {
      const perDay = Math.round(cents / 30);
      await db.query(
        `INSERT INTO expense (store_id, category_id, amount_cents, incurred_on, note, created_by)
         VALUES ($1,$2,$3,$4::date,$5,$6)`,
        [storeId, expenseCategoryIds[name], perDay, date.toISOString().slice(0, 10),
         `${name} — daily accrual`, userIds['OWNER']],
      );
      expenseCount++;
    }
  }

  return {
    storeId,
    users: users.map((u) => ({ email: u.email, password: u.password, role: u.role })),
    products: products.length,
    sales: salesWritten,
    expenses: expenseCount,
  };
}
