import { supabase } from "@/integrations/supabase/client";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const invokeFunction = async (name: string, body: Record<string, unknown> = {}) => {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Function ${name} failed`);
  return data;
};

export const asaasService = {
  /** Creates Asaas customer linked to donor */
  async createCustomer(donor_id: string | number, name: string, email: string, phone: string) {
    return invokeFunction('asaas-create-customer', { donor_id, name, email, phone });
  },

  /** Create a new charge */
  async createPayment(params: {
    donor_id: string | number;
    customer: string;
    billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
    value: number;
    dueDate: string;
    description?: string;
  }) {
    return invokeFunction('asaas-create-payment', params);
  },

  /** Check real status from Asaas */
  async getPaymentStatus(payment_id: string) {
    return invokeFunction('asaas-get-payment-status', { payment_id });
  },

  /** Get payments logs (webhooks) */
  async getLogs(limit = 50) {
    const { data, error } = await supabase
      .from('payments_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      if (error.message?.includes('Could not find') || error.code === '42P01') return [];
      throw error;
    }
    return data || [];
  },

  /** Fetch donations handled by Asaas */
  async getDonations() {
    const { data, error } = await supabase
      .from('donations')
      .select('*, donors(name, email, phone)')
      .not('asaas_payment_id', 'is', null)
      .order('donation_date', { ascending: false });
    if (error) {
      console.error("[asaasService.getDonations] Supabase error:", error);
      // Catch missing column 'asaas_payment_id' if migration wasn't run
      if (
        error.message?.includes('Could not find') || 
        error.message?.includes('does not exist') ||
        error.code === 'PGRST200' || 
        error.code === '42703'
      ) {
        return [];
      }
      throw error;
    }
    return data || [];
  },

  /** Generate dashboard data */
  async getDashboardData() {
    const today = new Date().toISOString().split('T')[0];
    const defaultStats = { totalToday: 0, totalConfirmed: 0, activeDonorsCount: 0, byType: { PIX: 0, BOLETO: 0, CREDIT_CARD: 0 }, totalDonationsCount: 0 };

    const { data: allDonations, error } = await supabase
      .from('donations')
      .select('amount, status, billing_type, donation_date, confirmed_at, donor_id')
      .not('asaas_payment_id', 'is', null);

    if (error) {
      console.error("[asaasService.getDashboardData] Supabase error:", error);
      if (
        error.message?.includes('Could not find') || 
        error.message?.includes('does not exist') ||
        error.code === 'PGRST200' || 
        error.code === '42703'
      ) {
        return defaultStats;
      }
      throw error;
    }

    const donations = allDonations || [];
    const isConfirmed = (status: string) => ['pago', 'confirmed', 'Confirmado'].includes(status);

    const todayStr = new Date().toDateString();
    const totalToday = donations
      .filter(d => {
        if (!isConfirmed(d.status)) return false;
        const dateStr = d.confirmed_at || d.donation_date;
        if (!dateStr) return false;
        // Compara no fuso local do browser para respeitar o horário do usuário
        return new Date(dateStr).toDateString() === todayStr;
      })
      .reduce((acc, d) => acc + parseFloat(d.amount), 0);

    const totalConfirmed = donations
      .filter(d => isConfirmed(d.status))
      .reduce((acc, d) => acc + parseFloat(d.amount), 0);

    const activeDonorsCount = new Set(
      donations.filter(d => isConfirmed(d.status)).map(d => d.donor_id)
    ).size;

    // Conta apenas pagamentos confirmados por tipo
    const confirmedDonations = donations.filter(d => isConfirmed(d.status));
    const byType = {
      PIX: confirmedDonations.filter(d => d.billing_type === 'PIX').length,
      BOLETO: confirmedDonations.filter(d => d.billing_type === 'BOLETO').length,
      CREDIT_CARD: confirmedDonations.filter(d => d.billing_type === 'CREDIT_CARD').length,
    };

    return { totalToday, totalConfirmed, activeDonorsCount, byType, totalDonationsCount: donations.length };
  }
};
