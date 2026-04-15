-- ============================================================
-- Fix: Idempotência de Webhooks Asaas e Correção de Dados
-- Execute no Supabase SQL Editor
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- PASSO 1: Remover logs duplicados — mantém apenas o primeiro
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
-- PASSO 2: Corrigir confirmed_at nas doações que ficaram com
-- o timestamp do retry em vez da data real de confirmação.
-- Usa o created_at do PRIMEIRO log RECEIVED/CONFIRMED para
-- cada payment_id como referência mais próxima da confirmação real.
-- ──────────────────────────────────────────────────────────────
UPDATE donations d
SET confirmed_at = pl.created_at
FROM (
  SELECT DISTINCT ON (payload->'payment'->>'id')
    payload->'payment'->>'id' AS payment_id,
    created_at
  FROM payments_logs
  WHERE event IN ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')
    AND payload->'payment'->>'id' IS NOT NULL
  ORDER BY payload->'payment'->>'id', created_at ASC
) pl
WHERE d.asaas_payment_id = pl.payment_id
  AND d.status = 'pago'
  -- Só atualiza se confirmed_at está muito longe da data real
  -- (diferença > 1 hora indica que foi salvo por um retry tardio)
  AND (d.confirmed_at IS NULL OR ABS(EXTRACT(EPOCH FROM (d.confirmed_at - pl.created_at))) > 3600);

-- ──────────────────────────────────────────────────────────────
-- PASSO 3: Verificação — mostra o estado após a correção
-- ──────────────────────────────────────────────────────────────
SELECT
  'Logs únicos por payment_id + event' AS label,
  COUNT(*) AS total
FROM payments_logs
WHERE payload->'payment'->>'id' IS NOT NULL;

SELECT
  'Doações confirmadas' AS label,
  COUNT(*) AS total,
  SUM(amount) AS total_amount
FROM donations
WHERE asaas_payment_id IS NOT NULL AND status = 'pago';

SELECT
  'Confirmadas hoje (UTC-3 / Brasília)' AS label,
  COUNT(*) AS total,
  SUM(amount) AS total_amount
FROM donations
WHERE asaas_payment_id IS NOT NULL
  AND status = 'pago'
  AND (confirmed_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date;
