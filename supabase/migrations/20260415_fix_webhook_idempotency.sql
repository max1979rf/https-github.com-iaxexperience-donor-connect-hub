-- ============================================================
-- Fix: Idempotência de Webhooks Asaas e Correção de Dados
-- Execute no Supabase SQL Editor
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- PASSO 1: Garantir que donation_date existe com default
-- ──────────────────────────────────────────────────────────────
ALTER TABLE donations ADD COLUMN IF NOT EXISTS donation_date timestamptz DEFAULT now();
UPDATE donations SET donation_date = now() WHERE donation_date IS NULL;

-- ──────────────────────────────────────────────────────────────
-- PASSO 2: Remover logs duplicados — mantém apenas o primeiro
-- registro de cada combinação event + payment_id
-- ──────────────────────────────────────────────────────────────
DELETE FROM payments_logs
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY event, payload->'payment'->>'id'
        ORDER BY created_at ASC
      ) AS rn
    FROM payments_logs
    WHERE payload->'payment'->>'id' IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- ──────────────────────────────────────────────────────────────
-- PASSO 3: Reconciliar — inserir doações que estão nos logs
-- de webhook (RECEIVED/CONFIRMED) mas NÃO estão na tabela donations
-- Isso corrige o segundo PIX (pay_orfs8m7xftt312xz) e qualquer outro
-- pagamento externo que falhou no auto-registro
-- ──────────────────────────────────────────────────────────────
INSERT INTO donations (
  asaas_payment_id,
  donor_id,
  amount,
  status,
  billing_type,
  donation_date,
  confirmed_at
)
SELECT DISTINCT ON (pl.payload->'payment'->>'id')
  pl.payload->'payment'->>'id'                                              AS asaas_payment_id,
  (
    SELECT id FROM donors
    WHERE asaas_customer_id = pl.payload->'payment'->>'customer'
    LIMIT 1
  )                                                                         AS donor_id,
  (pl.payload->'payment'->>'value')::numeric                                AS amount,
  'pago'                                                                    AS status,
  COALESCE(
    NULLIF(pl.payload->'payment'->>'billingType', ''),
    'PIX'
  )                                                                         AS billing_type,
  COALESCE(
    NULLIF(pl.payload->'payment'->>'confirmedDate', '')::timestamptz,
    NULLIF(pl.payload->'payment'->>'dateCreated', '')::timestamptz,
    pl.created_at
  )                                                                         AS donation_date,
  COALESCE(
    NULLIF(pl.payload->'payment'->>'confirmedDate', '')::timestamptz,
    pl.created_at
  )                                                                         AS confirmed_at
FROM payments_logs pl
WHERE pl.event IN ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')
  AND pl.payload->'payment'->>'id' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM donations d
    WHERE d.asaas_payment_id = pl.payload->'payment'->>'id'
  )
ORDER BY pl.payload->'payment'->>'id', pl.created_at ASC;

-- ──────────────────────────────────────────────────────────────
-- PASSO 4: Atualizar confirmed_at nas doações existentes que
-- estão como 'pago' mas sem confirmed_at (dados históricos)
-- ──────────────────────────────────────────────────────────────
UPDATE donations d
SET confirmed_at = COALESCE(
    NULLIF(pl.payload->'payment'->>'confirmedDate', '')::timestamptz,
    pl.created_at
  )
FROM (
  SELECT DISTINCT ON (payload->'payment'->>'id')
    payload->'payment'->>'id'  AS payment_id,
    created_at,
    payload
  FROM payments_logs
  WHERE event IN ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')
    AND payload->'payment'->>'id' IS NOT NULL
  ORDER BY payload->'payment'->>'id', created_at ASC
) pl
WHERE d.asaas_payment_id = pl.payment_id
  AND d.status = 'pago'
  AND d.confirmed_at IS NULL;

-- ──────────────────────────────────────────────────────────────
-- PASSO 5: Verificação — mostre o estado após a correção
-- ──────────────────────────────────────────────────────────────
SELECT
  'Total doações Asaas' AS label,
  COUNT(*) AS total,
  SUM(amount) AS total_amount
FROM donations
WHERE asaas_payment_id IS NOT NULL;

SELECT
  'Confirmadas' AS label,
  COUNT(*) AS total,
  SUM(amount) AS total_amount
FROM donations
WHERE asaas_payment_id IS NOT NULL AND status = 'pago';

SELECT
  id,
  asaas_payment_id,
  amount,
  status,
  billing_type,
  donation_date,
  confirmed_at
FROM donations
WHERE asaas_payment_id IS NOT NULL
ORDER BY donation_date DESC NULLS LAST
LIMIT 10;
