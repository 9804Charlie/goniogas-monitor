# goniogas-monitor

Cloudflare Worker que vigila el stock del "Cilindro de gas de 10kg" en
[goniogas.com](https://goniogas.com/producto/cilindro-de-gas-de-10kg/) (producto
WooCommerce `id=108`) y avisa por Telegram en cuanto vuelve a haber
existencias, con un botón que lleva directo al checkout con 2 cilindros ya
añadidos al carrito.

**No compra nada automáticamente.** El pago, los datos de envío y la
confirmación final los rellenas tú a mano — el bot solo detecta el cambio de
stock y te deja el carrito preparado, para no guardar datos de pago en
Cloudflare ni arriesgarte a que los "controles antifraude" del sitio bloqueen
la cuenta por una compra automática.

## Cómo funciona

- Un **Cron Trigger** (`*/5 * * * *`, cada 5 minutos) llama a la API pública
  de WooCommerce: `GET /wp-json/wc/store/v1/products/108`, que devuelve JSON
  con `is_in_stock`. No hace falta raspar HTML ni autenticarse.
- El último estado conocido (`in_stock` / `out_of_stock`) se guarda en **KV**.
  Solo se notifica en la transición de "sin stock" a "con stock", para no
  repetir el aviso en cada chequeo mientras dure la existencia.
- El aviso de Telegram incluye un botón "Comprar 2 cilindros ahora" que
  enlaza a `https://goniogas.com/checkout/?add-to-cart=108&quantity=2`. Es el
  parámetro estándar de WooCommerce para añadir al carrito por URL — en
  cuanto haya stock real, comprueba que efectivamente añade 2 unidades (algún
  tema/plugin lo sobrescribe); si no, ajusta la cantidad a mano en el
  carrito.

## Puesta en marcha

1. **Bot de Telegram**: habla con [@BotFather](https://t.me/BotFather),
   `/newbot`, y guarda el token.
2. **Chat ID**: envíale cualquier mensaje a tu bot nuevo y luego abre
   `https://api.telegram.org/bot<TOKEN>/getUpdates` en el navegador — el
   `chat.id` que aparece es tu `TELEGRAM_CHAT_ID`.
3. **Namespace de KV**: en el panel de Cloudflare, Workers & Pages → KV →
   *Create namespace* → llámalo `STOCK_KV`. Copia el ID y pégalo en
   `wrangler.toml` en vez de `REEMPLAZAR_CON_EL_ID_DEL_NAMESPACE`.
4. **Repo en GitHub**: créalo a mano en github.com/new (recuerda que
   `api.github.com` está bloqueado en la oficina, pero `git push` normal sí
   funciona), luego:
   ```
   git init
   git add -A
   git commit -m "Monitor de stock de goniogas.com con aviso por Telegram"
   git remote add origin https://github.com/9804Charlie/goniogas-monitor.git
   git push -u origin main
   ```
5. **Conectar el Worker**: panel de Cloudflare → Workers & Pages → *Create* →
   *Import a Git repository* → selecciona el repo. Deploy command:
   `npx wrangler deploy` (igual que en `telegram-ocr-bot`). Cada push a
   `main` lo redespliega solo.
6. **Secretos**: en el Worker ya desplegado, Settings → Variables and
   Secrets → añade `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` y `CHECK_SECRET`
   (invéntate una cadena larga para este último, protege el endpoint manual).
7. **Comprueba el Cron Trigger**: Settings → Triggers → tiene que aparecer
   `*/5 * * * *`. ⚠️ En el proyecto del monitor de trámite consular el cron
   nunca llegó a disparar solo con el deploy vía panel — no lo des por
   sentado, revisa aquí después del primer deploy y, si tras 10-15 min no
   aparece ninguna invocación en los logs, ese es el primer sitio donde
   mirar.

## Probarlo

- `GET https://goniogas-monitor.<tu-subdominio>.workers.dev/test-notify?key=<CHECK_SECRET>`
  manda un Telegram de prueba con el botón, sin tocar el estado guardado —
  sirve para validar el token/chat_id antes de esperar a que haya stock real.
- `GET https://goniogas-monitor.<tu-subdominio>.workers.dev/check?key=<CHECK_SECRET>`
  fuerza un chequeo real ahora mismo y devuelve el JSON del resultado
  (`inStock`, `previousState`, `newState`, `notified`).
- `GET https://goniogas-monitor.<tu-subdominio>.workers.dev/` muestra el
  último estado conocido en texto plano.

## Desarrollo local

```
npm install
cp .dev.vars.example .dev.vars   # rellena tus valores reales
npm run dev
```
