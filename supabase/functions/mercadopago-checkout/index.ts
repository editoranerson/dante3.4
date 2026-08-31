import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const PLANS: Record<string, { title: string; price: number }> = {
  dante_plus: { title: "Dante Plus", price: 4.9 },
  dante_premium: { title: "Dante Premium", price: 9.9 },
  dante_premium_plus: { title: "Dante Premium+", price: 19.9 },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
    if (!token) {
      return new Response(JSON.stringify({ error: "Pagamento não configurado." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autenticado." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Sessão inválida. Faça login novamente." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const planId = String(body.plan ?? "");
    const plan = PLANS[planId];
    if (!plan) {
      return new Response(JSON.stringify({ error: `Plano inválido: ${planId}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const successUrl = String(body.success_url ?? "");
    const backUrl = /^https:\/\//.test(successUrl) ? successUrl : "";

    const payerEmail = userData.user.email ?? "";
    if (!payerEmail) {
      return new Response(
        JSON.stringify({ error: "E-mail não encontrado. Atualize seu cadastro." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Checkout Transparente - Cria um link de pagamento customizado
    const preference: Record<string, unknown> = {
      items: [
        {
          id: planId,
          title: plan.title,
          quantity: 1,
          unit_price: plan.price,
          currency_id: "BRL",
        },
      ],
      payer: {
        email: payerEmail,
      },
      external_reference: `${userData.user.id}:${planId}`,
      back_urls: {
        success: backUrl || "",
        failure: backUrl || "",
        pending: backUrl || "",
      },
      auto_return: "approved",
      // Impede redirecionamento automático para app
      binary_mode: false,
      // Webhook para notificações
      notification_url: `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/mercadopago-webhook`,
    };

    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(preference),
    });

    const raw = await mpRes.text();
    if (!mpRes.ok) {
      let msg = `Mercado Pago recusou a solicitação (${mpRes.status}).`;
      try {
        const e = JSON.parse(raw) as {
          message?: string;
          error?: string;
          cause?: Array<{ description?: string }>;
        };
        if (e.cause?.[0]?.description) msg = e.cause[0].description;
        else if (e.message) msg = e.message;
        else if (e.error) msg = e.error;
      } catch {
        /* mantém mensagem padrão */
      }
      return new Response(JSON.stringify({ error: msg }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = JSON.parse(raw) as {
      init_point?: string;
      sandbox_init_point?: string;
      id?: string;
    };

    return new Response(
      JSON.stringify({
        init_point: data.init_point ?? data.sandbox_init_point,
        id: data.id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch {
    return new Response(
      JSON.stringify({ error: "Erro interno do servidor." }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
