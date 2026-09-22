const PRODUCT_ID = 108;
const STORE_API_URL = `https://goniogas.com/wp-json/wc/store/v1/products/${PRODUCT_ID}`;
const BUY_URL = `https://goniogas.com/checkout/?add-to-cart=${PRODUCT_ID}&quantity=2`;
const KV_KEY = "goniogas_108_stock_state";

async function checkStock() {
  const res = await fetch(STORE_API_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; goniogas-monitor/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Store API respondio ${res.status}`);
  }
  const data = await res.json();
  return {
    inStock: data.is_in_stock === true,
    name: data.name,
    priceCents: data.prices?.price ?? null,
  };
}

async function sendTelegram(env, text) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "Comprar 2 cilindros ahora", url: BUY_URL }]],
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram respondio ${res.status}: ${errText}`);
  }
}

// Solo notifica en la transicion sin_stock -> con_stock, para no repetir avisos
// en cada chequeo mientras siga habiendo existencias.
async function runCheck(env) {
  const status = await checkStock();
  const prevState = await env.STOCK_KV.get(KV_KEY);
  const newState = status.inStock ? "in_stock" : "out_of_stock";

  let notified = false;
  if (newState === "in_stock" && prevState !== "in_stock") {
    const priceEuros = status.priceCents ? (Number(status.priceCents) / 100).toFixed(2) : "?";
    await sendTelegram(
      env,
      `🔥 <b>Hay existencias</b> de "${status.name}" (${priceEuros} €).\n\n` +
        `Pulsa el botón para añadir 2 cilindros al carrito y pasar a caja. ` +
        `Recuerda: hay que entregar una bombona vacía al recoger, y solo tienes ` +
        `1 semana de plazo para pasar a recogerlo tras el pedido.`
    );
    notified = true;
  }

  await env.STOCK_KV.put(KV_KEY, newState);
  return { ...status, previousState: prevState, newState, notified, checkedAt: new Date().toISOString() };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCheck(env).catch((err) => console.error("Error en chequeo programado:", err))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      if (url.searchParams.get("key") !== env.CHECK_SECRET) {
        return new Response("No autorizado", { status: 401 });
      }
      try {
        const result = await runCheck(env);
        return Response.json(result);
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    // Prueba solo el envio de Telegram (boton incluido) sin tocar el estado
    // guardado en KV. Util para validar el token/chat_id antes de esperar
    // a que haya existencias reales.
    if (url.pathname === "/test-notify") {
      if (url.searchParams.get("key") !== env.CHECK_SECRET) {
        return new Response("No autorizado", { status: 401 });
      }
      try {
        await sendTelegram(
          env,
          "✅ Prueba de goniogas-monitor: así se verá el aviso cuando haya existencias."
        );
        return new Response("Notificacion de prueba enviada.\n");
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/") {
      const state = (await env.STOCK_KV.get(KV_KEY)) ?? "desconocido (aun no se ha ejecutado ningun chequeo)";
      return new Response(`goniogas-monitor activo. Ultimo estado conocido: ${state}\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
