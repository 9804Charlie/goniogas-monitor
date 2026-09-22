const PRODUCT_ID = 108;
const STORE_API_URL = `https://goniogas.com/wp-json/wc/store/v1/products/${PRODUCT_ID}`;
const STOCK_KV_KEY = "goniogas_108_stock_state";
const SUB_PREFIX = "sub:";
const STATE_PREFIX = "state:";
const DEFAULT_QUANTITY = 2;
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 20;

function buyUrl(quantity) {
  return `https://goniogas.com/checkout/?add-to-cart=${PRODUCT_ID}&quantity=${quantity}`;
}

function buyKeyboard(quantity) {
  const label = `Comprar ${quantity} cilindro${quantity === 1 ? "" : "s"} ahora`;
  return { inline_keyboard: [[{ text: label, url: buyUrl(quantity) }]] };
}

async function telegramApi(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} fallo: ${JSON.stringify(data)}`);
  }
  return data.result;
}

function sendMessage(env, chatId, text, replyMarkup) {
  return telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

function answerCallbackQuery(env, callbackQueryId, text) {
  return telegramApi(env, "answerCallbackQuery", { callback_query_id: callbackQueryId, text });
}

function editMessageText(env, chatId, messageId, text) {
  return telegramApi(env, "editMessageText", { chat_id: chatId, message_id: messageId, text });
}

function isAdmin(env, chatId) {
  return String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

async function getSubscriber(env, chatId) {
  const raw = await env.STOCK_KV.get(SUB_PREFIX + chatId);
  return raw ? JSON.parse(raw) : null;
}

async function putSubscriber(env, chatId, record) {
  await env.STOCK_KV.put(SUB_PREFIX + chatId, JSON.stringify(record));
}

async function getApprovedSubscribers(env) {
  const list = await env.STOCK_KV.list({ prefix: SUB_PREFIX });
  const records = await Promise.all(list.keys.map((k) => env.STOCK_KV.get(k.name)));
  return records.map((raw) => (raw ? JSON.parse(raw) : null)).filter((rec) => rec && rec.status === "approved");
}

async function askQuantity(env, chatId) {
  await env.STOCK_KV.put(STATE_PREFIX + chatId, "awaiting_quantity");
  await sendMessage(
    env,
    chatId,
    `¿Cuántos cilindros quieres que añada el enlace de compra cuando avise de stock? ` +
      `Respóndeme solo con el número (por defecto ${DEFAULT_QUANTITY}).`
  );
}

async function handleQuantityAnswer(env, chatId, text) {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < MIN_QUANTITY || n > MAX_QUANTITY) {
    await sendMessage(env, chatId, `Respóndeme solo con un número entero entre ${MIN_QUANTITY} y ${MAX_QUANTITY}, por favor.`);
    return;
  }
  const existing = (await getSubscriber(env, chatId)) ?? {
    chatId,
    status: isAdmin(env, chatId) ? "approved" : "pending",
  };
  await putSubscriber(env, chatId, { ...existing, quantity: n });
  await env.STOCK_KV.delete(STATE_PREFIX + chatId);
  await sendMessage(env, chatId, `Guardado. El enlace de compra añadirá ${n} cilindro${n === 1 ? "" : "s"} al carrito.`);
}

async function checkStock() {
  const res = await fetch(STORE_API_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; goniogas-monitor/1.0)" },
  });
  if (!res.ok) throw new Error(`Store API respondio ${res.status}`);
  const data = await res.json();
  return {
    inStock: data.is_in_stock === true,
    name: data.name,
    priceCents: data.prices?.price ?? null,
  };
}

async function broadcastStockAlert(env, status) {
  const priceEuros = status.priceCents ? (Number(status.priceCents) / 100).toFixed(2) : "?";
  const baseText =
    `🔥 <b>Hay existencias</b> de "${status.name}" (${priceEuros} €).\n\n` +
    `Pulsa el botón para añadir tus cilindros al carrito y pasar a caja. ` +
    `Recuerda: hay que entregar una bombona vacía al recoger, y solo tienes ` +
    `1 semana de plazo para pasar a recogerlo tras el pedido.`;

  const approved = await getApprovedSubscribers(env);
  const adminRecord = await getSubscriber(env, env.TELEGRAM_CHAT_ID);

  const targets = new Map();
  targets.set(String(env.TELEGRAM_CHAT_ID), adminRecord?.quantity ?? DEFAULT_QUANTITY);
  for (const rec of approved) {
    targets.set(String(rec.chatId), rec.quantity ?? DEFAULT_QUANTITY);
  }

  await Promise.allSettled(
    [...targets.entries()].map(([chatId, quantity]) =>
      sendMessage(env, chatId, baseText, buyKeyboard(quantity))
    )
  );
}

// Solo notifica en la transicion sin_stock -> con_stock, para no repetir avisos
// en cada chequeo mientras siga habiendo existencias.
async function runCheck(env) {
  const status = await checkStock();
  const prevState = await env.STOCK_KV.get(STOCK_KV_KEY);
  const newState = status.inStock ? "in_stock" : "out_of_stock";

  let notified = false;
  if (newState === "in_stock" && prevState !== "in_stock") {
    await broadcastStockAlert(env, status);
    notified = true;
  }

  await env.STOCK_KV.put(STOCK_KV_KEY, newState);
  return { ...status, previousState: prevState, newState, notified, checkedAt: new Date().toISOString() };
}

async function handleStart(env, chatId, from) {
  if (isAdmin(env, chatId)) {
    const record = (await getSubscriber(env, chatId)) ?? { chatId, status: "approved" };
    await putSubscriber(env, chatId, { ...record, status: "approved" });
    if (record.quantity) {
      await sendMessage(
        env,
        chatId,
        `Eres el administrador de este bot. Cantidad configurada actualmente: ${record.quantity}. Usa /cantidad para cambiarla.`
      );
    } else {
      await sendMessage(env, chatId, "Eres el administrador de este bot, ya recibes los avisos de stock automáticamente.");
      await askQuantity(env, chatId);
    }
    return;
  }

  const existing = await getSubscriber(env, chatId);
  if (existing?.status === "approved") {
    await sendMessage(env, chatId, "Ya estás suscrito a los avisos de stock de cilindros de gas. Usa /cantidad o /stop.");
    return;
  }
  if (existing?.status === "pending") {
    await sendMessage(env, chatId, "Tu solicitud ya está pendiente de aprobación, te avisaré en cuanto el administrador la revise.");
    return;
  }

  const record = {
    chatId,
    status: "pending",
    name: [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "Sin nombre",
    username: from?.username ?? null,
    requestedAt: new Date().toISOString(),
  };
  await putSubscriber(env, chatId, record);
  await sendMessage(
    env,
    chatId,
    "Solicitud enviada. En cuanto el administrador la apruebe, te avisaré por aquí cuando haya existencias."
  );
  await askQuantity(env, chatId);

  const adminText =
    `👤 Nueva solicitud de avisos de stock:\n` +
    `<b>${record.name}</b>${record.username ? " (@" + record.username + ")" : ""}\n` +
    `chat_id: ${chatId}`;
  await sendMessage(env, env.TELEGRAM_CHAT_ID, adminText, {
    inline_keyboard: [
      [
        { text: "✅ Aprobar", callback_data: `approve:${chatId}` },
        { text: "❌ Rechazar", callback_data: `reject:${chatId}` },
      ],
    ],
  });
}

async function handleStop(env, chatId) {
  const existing = await getSubscriber(env, chatId);
  if (!existing || existing.status === "removed") {
    await sendMessage(env, chatId, "No estabas suscrito a los avisos.");
    return;
  }
  await putSubscriber(env, chatId, { ...existing, status: "removed" });
  await sendMessage(env, chatId, "Listo, ya no recibirás avisos de stock. Puedes volver a pedirlo con /start cuando quieras.");
}

async function handleQuantityCommand(env, chatId, text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length > 1) {
    await handleQuantityAnswer(env, chatId, parts[1]);
    return;
  }
  await askQuantity(env, chatId);
}

async function handleMessage(env, message) {
  const chatId = message.chat.id;
  const text = (message.text ?? "").trim();

  const state = await env.STOCK_KV.get(STATE_PREFIX + chatId);
  if (state === "awaiting_quantity" && !text.startsWith("/")) {
    await handleQuantityAnswer(env, chatId, text);
    return;
  }

  if (text.startsWith("/start")) {
    await handleStart(env, chatId, message.from);
  } else if (text.startsWith("/stop")) {
    await handleStop(env, chatId);
  } else if (text.startsWith("/cantidad")) {
    await handleQuantityCommand(env, chatId, text);
  } else {
    await sendMessage(
      env,
      chatId,
      "Comandos disponibles:\n/start — pedir avisos de stock de cilindros de gas\n/cantidad — cambiar cuántos cilindros pedir\n/stop — darte de baja"
    );
  }
}

async function handleCallbackQuery(env, callbackQuery) {
  const fromId = callbackQuery.from.id;
  if (!isAdmin(env, fromId)) {
    await answerCallbackQuery(env, callbackQuery.id, "No autorizado.");
    return;
  }

  const [action, targetChatIdRaw] = (callbackQuery.data ?? "").split(":");
  const targetChatId = Number(targetChatIdRaw);
  const existing = await getSubscriber(env, targetChatId);
  if (!existing) {
    await answerCallbackQuery(env, callbackQuery.id, "Esa solicitud ya no existe.");
    return;
  }

  if (action === "approve") {
    await putSubscriber(env, targetChatId, { ...existing, status: "approved" });
    await answerCallbackQuery(env, callbackQuery.id, "Aprobado.");
    await sendMessage(
      env,
      targetChatId,
      "✅ Tu solicitud fue aprobada. A partir de ahora te avisaré por aquí cuando haya existencias."
    );
  } else if (action === "reject") {
    await putSubscriber(env, targetChatId, { ...existing, status: "rejected" });
    await answerCallbackQuery(env, callbackQuery.id, "Rechazado.");
    await sendMessage(env, targetChatId, "❌ Tu solicitud de avisos no fue aprobada.");
  } else {
    await answerCallbackQuery(env, callbackQuery.id, "Acción desconocida.");
    return;
  }

  const msg = callbackQuery.message;
  if (msg) {
    const decision = action === "approve" ? "✅ Aprobado" : "❌ Rechazado";
    await editMessageText(env, msg.chat.id, msg.message_id, `${msg.text}\n\n${decision}`);
  }
}

function checkAuth(request, url, env) {
  return url.searchParams.get("key") === env.CHECK_SECRET;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env).catch((err) => console.error("Error en chequeo programado:", err)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/telegram-webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.CHECK_SECRET) {
        return new Response("No autorizado", { status: 401 });
      }
      const update = await request.json();
      try {
        if (update.message) {
          await handleMessage(env, update.message);
        } else if (update.callback_query) {
          await handleCallbackQuery(env, update.callback_query);
        }
      } catch (err) {
        console.error("Error procesando update de Telegram:", err);
      }
      return new Response("OK");
    }

    if (url.pathname === "/setup-webhook") {
      if (!checkAuth(request, url, env)) return new Response("No autorizado", { status: 401 });
      const webhookUrl = `${url.origin}/telegram-webhook`;
      const result = await telegramApi(env, "setWebhook", { url: webhookUrl, secret_token: env.CHECK_SECRET });
      return Response.json({ webhookUrl, result });
    }

    if (url.pathname === "/check") {
      if (!checkAuth(request, url, env)) return new Response("No autorizado", { status: 401 });
      try {
        const result = await runCheck(env);
        return Response.json(result);
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    // Prueba solo el envio de Telegram al administrador (boton incluido) sin
    // tocar el estado guardado en KV ni avisar a los suscriptores.
    if (url.pathname === "/test-notify") {
      if (!checkAuth(request, url, env)) return new Response("No autorizado", { status: 401 });
      try {
        const adminRecord = await getSubscriber(env, env.TELEGRAM_CHAT_ID);
        const quantity = adminRecord?.quantity ?? DEFAULT_QUANTITY;
        await sendMessage(
          env,
          env.TELEGRAM_CHAT_ID,
          `✅ Prueba de goniogas-monitor: así se verá el aviso cuando haya existencias (cantidad configurada: ${quantity}).`,
          buyKeyboard(quantity)
        );
        return new Response("Notificacion de prueba enviada.\n");
      } catch (err) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    if (url.pathname === "/") {
      const state = (await env.STOCK_KV.get(STOCK_KV_KEY)) ?? "desconocido (aun no se ha ejecutado ningun chequeo)";
      return new Response(`goniogas-monitor activo. Ultimo estado conocido: ${state}\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
