import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  );

  try {
    const body = await req.json();
    const { event, payment } = body;

    const asaasPaymentId = payment?.id;

    if (!['PAYMENT_CREATED', 'PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED'].includes(event)) {
      return new Response(JSON.stringify({ message: 'Event ignored' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!asaasPaymentId) {
      return new Response(JSON.stringify({ error: 'No payment id' }), { status: 400 });
    }

    // Idempotency check: se este evento para este pagamento já foi processado, ignora
    const { count: existingCount } = await supabase
      .from('payments_logs')
      .select('id', { count: 'exact', head: true })
      .eq('event', event)
      .filter('payload->payment->>id', 'eq', asaasPaymentId);

    if ((existingCount ?? 0) > 0) {
      console.log(`[Asaas Webhook] Duplicate event ${event} for ${asaasPaymentId} — ignoring.`);
      return new Response(JSON.stringify({ message: 'Already processed' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Registra log do evento (primeira ocorrência)
    await supabase.from('payments_logs').insert([{ event, payload: body }]);

    // Map Asaas event to our status
    const statusMap: Record<string, string> = {
      PAYMENT_CREATED: 'pendente',
      PAYMENT_RECEIVED: 'pago',
      PAYMENT_CONFIRMED: 'pago',
      PAYMENT_OVERDUE: 'pendente',
      PAYMENT_DELETED: 'cancelado',
    };
    const newStatus = statusMap[event] || 'pendente';

    // Data real de confirmação do Asaas (evita usar hora do retry como confirmed_at)
    const confirmedAt = newStatus === 'pago'
      ? (payment.confirmedDate
          ? new Date(payment.confirmedDate).toISOString()
          : new Date().toISOString())
      : null;

    // Update donation
    const { data: updated, error } = await supabase
      .from('donations')
      .update({ status: newStatus, confirmed_at: confirmedAt })
      .eq('asaas_payment_id', asaasPaymentId)
      .select();

    if (error) throw error;

    let affectedRows = updated?.length || 0;

    // Se nao achou no banco, foi gerada fora do sistema (ex: portal asaas) -> auto-registro!
    if (affectedRows === 0 && payment) {
      console.log(`[Asaas Webhook] Payment ${asaasPaymentId} not found. Auto-registering...`);
      // Tenta achar o doador pelo customer_id do asaas
      let donorId = null;
      if (payment.customer) {
        const { data: donor } = await supabase.from('donors').select('id').eq('asaas_customer_id', payment.customer).maybeSingle();
        if (donor) donorId = donor.id;
      }

      const donationDate = payment.dateCreated
        ? new Date(payment.dateCreated).toISOString()
        : new Date().toISOString();

      const { data: newDonation, error: insertErr } = await supabase.from('donations').insert([{
        donor_id: donorId,
        amount: payment.value,
        status: newStatus,
        asaas_payment_id: asaasPaymentId,
        billing_type: payment.billingType,
        due_date: payment.dueDate,
        donation_date: donationDate,
        confirmed_at: confirmedAt,
      }]).select();

      if (insertErr) throw insertErr;
      console.log(`[Asaas Webhook] Auto-registered external donation:`, newDonation);
      affectedRows = newDonation ? newDonation.length : 1;
    } else {
      console.log(`[Asaas Webhook] ${event} → donation updated:`, updated);
    }

    return new Response(JSON.stringify({ success: true, updated: affectedRows }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[Asaas Webhook] Error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
