-- 0001_init.sql — initial schema
-- Money is stored as an integer number of centavos. Never float, never bigint:
-- every aggregate is cast back to ::int so no driver hands us a BigInt or a string.

-- ---------------------------------------------------------------- tenancy
CREATE TABLE store (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'Asia/Manila',
  currency    text NOT NULL DEFAULT 'PHP',
  vat_rate_bp integer NOT NULL DEFAULT 0,          -- basis points; 1200 = 12%
  tax_mode    text NOT NULL DEFAULT 'EXCLUSIVE' CHECK (tax_mode IN ('EXCLUSIVE','INCLUSIVE')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_grant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  store_id   uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('OWNER','MANAGER','CASHIER','VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, store_id)
);

-- Rotating refresh token families. Reusing a rotated token revokes the family.
CREATE TABLE refresh_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_token_family_idx ON refresh_token (family_id);

-- ---------------------------------------------------------------- catalog
CREATE TABLE category (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id  uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name      text NOT NULL,
  parent_id uuid REFERENCES category(id),
  UNIQUE (store_id, name)
);

CREATE TABLE supplier (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name            text NOT NULL,
  contact         text,
  lead_time_days  integer NOT NULL DEFAULT 3 CHECK (lead_time_days >= 0),
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE product (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  category_id         uuid REFERENCES category(id),
  supplier_id         uuid REFERENCES supplier(id),
  sku                 text NOT NULL,
  name                text NOT NULL,
  barcode             text,
  unit                text NOT NULL DEFAULT 'pc',
  selling_price_cents integer NOT NULL CHECK (selling_price_cents >= 0),
  avg_cost_cents      integer NOT NULL DEFAULT 0 CHECK (avg_cost_cents >= 0),
  tax_rate_bp         integer NOT NULL DEFAULT 0,
  reorder_point       integer NOT NULL DEFAULT 0,
  target_cover_days   integer NOT NULL DEFAULT 14,
  pack_size           integer NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  is_active           boolean NOT NULL DEFAULT true,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, sku)
);
CREATE INDEX product_barcode_idx ON product (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX product_store_active_idx ON product (store_id) WHERE deleted_at IS NULL;

-- Derived cache of on-hand stock. Recomputable from stock_movement at any time.
CREATE TABLE stock_level (
  product_id uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  store_id   uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  on_hand    integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, store_id)
);

-- Append-only stock ledger. There is no other way to change on-hand quantity.
CREATE TABLE stock_movement (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  store_id         uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('IN','OUT')),
  reason           text NOT NULL CHECK (reason IN
                     ('PURCHASE','RETURN_FROM_CUSTOMER','ADJUSTMENT_UP','TRANSFER_IN',
                      'SALE','SPOILAGE','DAMAGE','ADJUSTMENT_DOWN','TRANSFER_OUT')),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_cost_cents  integer NOT NULL DEFAULT 0,
  reference_type   text,
  reference_id     uuid,
  actor_id         uuid REFERENCES app_user(id),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX movement_product_time_idx ON stock_movement (product_id, store_id, created_at DESC);
CREATE INDEX movement_reason_idx ON stock_movement (reason, created_at DESC);

CREATE TABLE stocktake (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','POSTED','CANCELLED')),
  opened_by  uuid REFERENCES app_user(id),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);

CREATE TABLE stocktake_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stocktake_id uuid NOT NULL REFERENCES stocktake(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  system_qty   integer NOT NULL,
  counted_qty  integer,
  UNIQUE (stocktake_id, product_id)
);

-- ---------------------------------------------------------------- purchasing
CREATE TABLE purchase_order (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  supplier_id      uuid NOT NULL REFERENCES supplier(id),
  reference        text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                     ('DRAFT','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED_SHORT','CANCELLED')),
  ordered_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES app_user(id),
  note             text,
  total_cost_cents integer NOT NULL DEFAULT 0
);

CREATE TABLE purchase_order_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES purchase_order(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES product(id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_cost_cents  integer NOT NULL CHECK (unit_cost_cents >= 0),
  received_qty     integer NOT NULL DEFAULT 0 CHECK (received_qty >= 0)
);

-- ---------------------------------------------------------------- sales
CREATE TABLE customer (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name           text NOT NULL,
  phone          text,
  balance_cents  integer NOT NULL DEFAULT 0
);

CREATE TABLE sale (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  cashier_id         uuid REFERENCES app_user(id),
  reference          text NOT NULL UNIQUE,
  idempotency_key    text UNIQUE,
  customer_id        uuid REFERENCES customer(id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  subtotal_cents     integer NOT NULL DEFAULT 0,
  discount_cents     integer NOT NULL DEFAULT 0,
  net_revenue_cents  integer NOT NULL DEFAULT 0,
  tax_cents          integer NOT NULL DEFAULT 0,
  total_cents        integer NOT NULL DEFAULT 0,
  gross_profit_cents integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','VOIDED','RETURNED')),
  void_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sale_store_time_idx ON sale (store_id, occurred_at DESC);
CREATE INDEX sale_cashier_idx ON sale (cashier_id, occurred_at DESC);

CREATE TABLE sale_item (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id            uuid NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
  product_id         uuid NOT NULL REFERENCES product(id),
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_price_cents   integer NOT NULL,
  -- Cost basis captured at the moment of sale. Written once, never recomputed:
  -- this is what keeps last month's report identical next month.
  unit_cost_cents    integer NOT NULL,
  discount_cents     integer NOT NULL DEFAULT 0,
  gross_profit_cents integer NOT NULL DEFAULT 0,
  returned_qty       integer NOT NULL DEFAULT 0
);
CREATE INDEX sale_item_product_idx ON sale_item (product_id, sale_id);

CREATE TABLE payment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id        uuid NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
  method         text NOT NULL CHECK (method IN ('CASH','EWALLET','CARD','CREDIT')),
  -- Zero is legal: a fully discounted (₱0) sale is settled with a zero tender.
  amount_cents   integer NOT NULL CHECK (amount_cents >= 0)
);

-- ---------------------------------------------------------------- expenses
CREATE TABLE expense_category (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  name     text NOT NULL,
  UNIQUE (store_id, name)
);

CREATE TABLE expense (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  category_id  uuid REFERENCES expense_category(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  incurred_on  date NOT NULL DEFAULT CURRENT_DATE,
  note         text,
  created_by   uuid REFERENCES app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expense_store_date_idx ON expense (store_id, incurred_on);

-- ---------------------------------------------------------------- AI layer
CREATE TABLE forecast (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  store_id        uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  horizon_date    date NOT NULL,
  predicted_units numeric(12,3) NOT NULL,
  lower_bound     numeric(12,3) NOT NULL,
  upper_bound     numeric(12,3) NOT NULL,
  model           text NOT NULL,
  mape            numeric(8,3),
  feature_hash    text,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, horizon_date, model)
);

CREATE TABLE reorder_suggestion (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    uuid NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  store_id      uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'SUGGESTED'
                  CHECK (status IN ('SUGGESTED','ACCEPTED','ORDERED','DISMISSED')),
  suggested_qty integer NOT NULL CHECK (suggested_qty > 0),
  reorder_point integer NOT NULL,
  on_hand       integer NOT NULL,
  on_order      integer NOT NULL DEFAULT 0,
  days_of_cover numeric(8,2),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX suggestion_open_idx ON reorder_suggestion (store_id, status, created_at DESC);

CREATE TABLE anomaly (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id     uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  severity     text NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  subject_type text NOT NULL,
  subject_id   uuid,
  message      text NOT NULL,
  metric       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE INDEX anomaly_open_idx ON anomaly (store_id, status, created_at DESC);

CREATE TABLE ai_conversation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   uuid NOT NULL REFERENCES store(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES app_user(id),
  title      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES ai_conversation(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content         text NOT NULL,
  tool_calls      jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider        text,
  tokens_in       integer NOT NULL DEFAULT 0,
  tokens_out      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- platform
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  store_id   uuid,
  actor_id   uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  changes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, created_at DESC);
CREATE INDEX audit_store_time_idx ON audit_log (store_id, created_at DESC);

-- Durable job queue. A real deployment swaps this for BullMQ on Redis; the
-- interface in worker/queue.ts is the only thing that changes.
CREATE TABLE job_queue (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX job_pending_idx ON job_queue (status, id) WHERE status IN ('PENDING','RUNNING');

CREATE TABLE setting (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The `migration` bookkeeping table is created by the migrator itself, before
-- the first migration runs, so it deliberately does not appear here.
