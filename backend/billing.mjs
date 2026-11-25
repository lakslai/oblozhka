import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const packPrice = 4990;
const monthlyPrice = 14990;
const monthlyUnits = 100;
const env = () => process.env;
const nowSeconds = () => Math.floor(Date.now() / 1000);
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
function requiredText(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) fail('Проверьте поле «' + label + '».');
  return value.trim();
}
function sandbox() { return env().BILLING_MODE !== 'stripe'; }
function atomic(db, fn) {
  db.exec('SAVEPOINT billing_change');
  try {
    const result = fn();
    db.exec('RELEASE billing_change');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO billing_change; RELEASE billing_change');
    throw error;
  }
}
export function initBilling(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
      plan TEXT NOT NULL, term TEXT NOT NULL, amount INTEGER NOT NULL, promo TEXT NOT NULL,
      method TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL,
      checkout_url TEXT, checkout_id TEXT, UNIQUE(user_id,request_key)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, provider_ref TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL REFERENCES billing_orders(id),
      user_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, units INTEGER NOT NULL,
      provider TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY REFERENCES users(id), order_id TEXT NOT NULL REFERENCES billing_orders(id),
      term TEXT NOT NULL, paid_start INTEGER NOT NULL, paid_end INTEGER NOT NULL,
      period_start INTEGER NOT NULL, remaining INTEGER NOT NULL, customer_id TEXT, provider_sub TEXT
    );
    CREATE INDEX IF NOT EXISTS billing_history ON transactions(user_id,created DESC);
    CREATE TABLE IF NOT EXISTS billing_requests (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, kind TEXT NOT NULL,
      details TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(user_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES billing_requests(id), created INTEGER NOT NULL,
      delivered INTEGER, attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
}
function monthsAfter(stamp, months) {
  const date = new Date(stamp * 1000);
  const desired = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(desired, lastDay));
  return Math.floor(date.valueOf() / 1000);
}
function currentMonth(start, now) {
  const a = new Date(start * 1000), b = new Date(now * 1000);
  const delta = 12 * (b.getUTCFullYear() - a.getUTCFullYear()) + b.getUTCMonth() - a.getUTCMonth();
  return monthsAfter(start, Math.max(0, delta - (monthsAfter(start, delta) > now ? 1 : 0)));
}
export function reconcileSubscription(db, userId, now = nowSeconds()) {
  return atomic(db, () => {
    const sub = db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(userId);
    if (!sub) return null;
    const valid = now < sub.paid_end;
    const period = valid ? currentMonth(sub.paid_start, now) : sub.paid_end;
    if (period !== sub.period_start) {
      const units = valid ? monthlyUnits : 0;
      db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(units - sub.remaining, userId);
      db.prepare('UPDATE subscriptions SET period_start=?,remaining=? WHERE user_id=?').run(period, units, userId);
    }
    return valid ? db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(userId) : null;
  });
}
export function consumeCredit(db, userId) {
  return atomic(db, () => {
    const sub = reconcileSubscription(db, userId);
    if (!db.prepare('UPDATE users SET credits=credits-1 WHERE id=? AND credits>0').run(userId).changes) return null;
    if (sub?.remaining > 0) {
      db.prepare('UPDATE subscriptions SET remaining=remaining-1 WHERE user_id=?').run(userId);
      return { source: 'plan', period: String(sub.period_start) };
    }
    return { source: 'wallet' };
  });
}
export function refundCredit(db, userId, receipt) {
  if (!receipt) return;
  atomic(db, () => {
    if (receipt.source === 'plan') {
      const sub = reconcileSubscription(db, userId);
      if (!sub || String(sub.period_start) !== receipt.period) return;
      db.prepare('UPDATE subscriptions SET remaining=remaining+1 WHERE user_id=?').run(userId);
    }
    db.prepare('UPDATE users SET credits=credits+1 WHERE id=?').run(userId);
  });
}
function quote(data) {
  if (!['pack', 'pro'].includes(data.plan)) fail('Выберите тариф.');
  const term = data.plan === 'pack' ? 'once' : data.term;
  if (!['once','month','year'].includes(term) || (data.plan === 'pro' && term === 'once')) fail('Выберите период подписки.');
  const promo = String(data.promo || '').trim().toUpperCase();
  const validCode = env().BILLING_PROMO_CODE?.trim().toUpperCase() || (sandbox() ? 'START10' : '');
  if (promo && promo !== validCode) fail('Промокод не найден.');
  const base = data.plan === 'pack' ? packPrice : term === 'year' ? Math.round(monthlyPrice * 12 * 0.8) : monthlyPrice;
  const amount = promo ? Math.round(base * 0.9) : base;
  return { plan: data.plan, term, amount, promo, base, units: data.plan === 'pack' ? 20 : monthlyUnits };
}
function requestKey(data) {
  if (typeof data.key !== 'string' || !/^[a-zA-Z0-9_-]{8,90}$/.test(data.key)) fail('Обновите форму и повторите запрос.');
  return data.key;
}
function state(db, userId) {
  const sub = reconcileSubscription(db, userId);
  return {
    mode: sandbox() ? 'sandbox' : 'stripe',
    credits: db.prepare('SELECT credits FROM users WHERE id=?').get(userId).credits,
    subscription: sub && { term: sub.term, until: sub.paid_end, remaining: sub.remaining, managed: !!sub.customer_id },
    transactions: db.prepare(`SELECT t.id,t.amount,t.units,t.provider,t.created,o.plan,o.term FROM transactions t
      JOIN billing_orders o ON o.id=t.order_id WHERE t.user_id=? ORDER BY t.created DESC,t.rowid DESC LIMIT 100`).all(userId),
    requests: db.prepare('SELECT id,kind,created,details FROM billing_requests WHERE user_id=? ORDER BY created DESC LIMIT 20').all(userId)
      .map(({details,...row})=>row.kind==='invoice' ? {...row,invoice:JSON.parse(details)} : row)
  };
}
function settle(db, order, reference, period = {}) {
  return atomic(db, () => {
    if (db.prepare('SELECT id FROM transactions WHERE provider_ref=?').get(reference)) return;
    if (order.plan === 'pack' && db.prepare('SELECT 1 FROM transactions WHERE order_id=?').get(order.id)) return;
    const now = nowSeconds();
    if (order.plan === 'pro') {
      const start = period.start || now;
      const end = period.end || monthsAfter(start, order.term === 'year' ? 12 : 1);
      const previous = db.prepare('SELECT * FROM subscriptions WHERE user_id=?').get(order.user_id);
      if (!previous || end > previous.paid_end) {
        const active = end > now;
        const nextRemaining = active ? monthlyUnits : 0;
        db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(nextRemaining - (previous?.remaining || 0), order.user_id);
        db.prepare(`INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET order_id=excluded.order_id,term=excluded.term,paid_start=excluded.paid_start,
          paid_end=excluded.paid_end,period_start=excluded.period_start,remaining=excluded.remaining,
          customer_id=excluded.customer_id,provider_sub=excluded.provider_sub`)
          .run(order.user_id, order.id, order.term, start, end, active ? currentMonth(start,now) : end,
            nextRemaining, period.customer || null, period.subscription || null);
      }
    } else {
      db.prepare('UPDATE users SET credits=credits+20 WHERE id=?').run(order.user_id);
    }
    db.prepare('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?)')
      .run(randomUUID(), reference, order.id, order.user_id, order.amount, order.plan === 'pack' ? 20 : monthlyUnits, order.provider, now);
    db.prepare("UPDATE billing_orders SET status='paid' WHERE id=?").run(order.id);
  });
}
function origin() {
  let url;
  try { url = new URL(env().APP_ORIGIN); } catch { fail('Администратору нужно задать APP_ORIGIN.',503); }
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) fail('Для оплаты нужен HTTPS.',503);
  return url.origin;
}
async function stripe(path, data, key) {
  if (!env().STRIPE_SECRET_KEY || !env().STRIPE_WEBHOOK_SECRET) fail('Платёжный шлюз ещё не настроен.',503);
  const resp = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + env().STRIPE_SECRET_KEY,
      'Content-Type':'application/x-www-form-urlencoded', ...(key ? {'Idempotency-Key':key} : {}) },
    body: new URLSearchParams(data), signal: AbortSignal.timeout(15000)
  }).catch(() => fail('Платёжный шлюз временно недоступен.',502));
  if (!resp.ok) fail('Шлюз отклонил запрос. Проверьте настройки платежей.',502);
  return resp.json();
}
async function createCheckout(db, user, data) {
  const q = quote(data), key = requestKey(data);
  const mode = sandbox() ? 'sandbox' : 'stripe';
  const previous = db.prepare('SELECT * FROM billing_orders WHERE user_id=? AND request_key=?').get(user.id,key);
  if (previous && (previous.plan !== q.plan || previous.term !== q.term || previous.amount !== q.amount || previous.provider !== mode)) fail('Параметры заказа изменились.',409);
  if (!previous && q.plan === 'pro') {
    if (reconcileSubscription(db,user.id)) fail('Подписка уже действует.',409);
    // A single open subscription checkout prevents two recurring Stripe contracts for one account.
    const open = db.prepare("SELECT * FROM billing_orders WHERE user_id=? AND provider='stripe' AND plan='pro' AND status='pending' AND created>?").get(user.id,nowSeconds()-86400);
    if (mode === 'stripe' && open) {
      if (open.term !== q.term || open.amount !== q.amount) fail('Уже открыт заказ с другими условиями. Завершите его или дождитесь окончания платёжной сессии.',409);
      if (open.checkout_url) return {id:open.id,url:open.checkout_url,amount:open.amount,status:open.status};
      // A missed gateway response can be recovered with the original Stripe idempotency key.
      return createCheckout(db,user,{...data,key:open.request_key});
    }
  }
  const order = previous || { id:randomUUID(), amount:q.amount, plan:q.plan, term:q.term, status:'pending' };
  if (!previous) db.prepare(`INSERT INTO billing_orders(id,user_id,request_key,plan,term,amount,promo,method,provider,status,created)
    VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`).run(order.id,user.id,key,q.plan,q.term,q.amount,q.promo,'card',mode,nowSeconds());
  if (mode === 'sandbox' || order.checkout_url || order.status === 'paid')
    return { id:order.id, amount:order.amount, status:order.status, url:order.checkout_url || null };
  const base = origin();
  const values = {
    mode:q.plan === 'pro' ? 'subscription' : 'payment',
    success_url:base+'/?checkout=success', cancel_url:base+'/?checkout=cancel',
    client_reference_id:order.id, customer_email:user.email, 'metadata[order_id]':order.id,
    'line_items[0][quantity]':'1', 'line_items[0][price_data][currency]':'kzt',
    'line_items[0][price_data][product_data][name]':q.plan === 'pro' ? 'Oblozhka · Профи' : 'Oblozhka · 20 генераций',
    'line_items[0][price_data][unit_amount]':String(q.amount*100),
    'payment_method_types[0]':'card'
  };
  if (q.plan === 'pro') {
    values['subscription_data[metadata][order_id]'] = order.id;
    values['line_items[0][price_data][recurring][interval]'] = q.term;
  }
  const session = await stripe('checkout/sessions',values,order.id);
  db.prepare('UPDATE billing_orders SET checkout_url=?,checkout_id=? WHERE id=?').run(session.url,session.id,order.id);
  return { id:order.id, amount:order.amount, status:'pending', url:session.url };
}
function verifyStripe(request, raw) {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (sandbox() || !secret) fail('Webhook отключён.',404);
  if (!Buffer.isBuffer(raw)) fail('Отсутствует исходное тело запроса.');
  const parts = String(request.headers['stripe-signature'] || '').split(',').map(s=>s.trim().split('='));
  const timestamp = parts.find(([k])=>k==='t')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(Number(timestamp)-nowSeconds()) > 300) fail('Подпись просрочена.',400);
  const expected = createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();
  if (!parts.some(([k,v])=> k==='v1' && /^[a-f0-9]{64}$/i.test(v || '') && timingSafeEqual(expected,Buffer.from(v,'hex')))) fail('Некорректная подпись.',400);
  try { return JSON.parse(raw.toString('utf8')); } catch { fail('Некорректное событие.'); }
}
function webhook({db,request,raw}) {
  const event = verifyStripe(request,raw);
  const obj = event.data?.object || {};
  if (!!event.livemode !== !!env().STRIPE_SECRET_KEY?.startsWith('sk_live_')) fail('Режим события не соответствует ключу.',400);
  if (event.type === 'checkout.session.expired') {
    db.prepare("UPDATE billing_orders SET status='expired' WHERE id=? AND provider='stripe' AND status='pending' AND checkout_id=?").run(obj.metadata?.order_id || '',obj.id);
  } else if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type) && obj.mode === 'payment' && obj.payment_status === 'paid') {
    const order = db.prepare("SELECT * FROM billing_orders WHERE id=? AND provider='stripe' AND plan='pack'").get(obj.metadata?.order_id || '');
    if (!order) return { received:true };
    if ((order.checkout_id && order.checkout_id !== obj.id) || obj.currency !== 'kzt' || obj.amount_total !== order.amount*100) fail('Детали платежа расходятся с заказом.');
    settle(db,order,'stripe:'+obj.id);
  } else if (event.type === 'invoice.paid') {
    const details = obj.parent?.subscription_details || obj.subscription_details;
    const order = db.prepare("SELECT * FROM billing_orders WHERE id=? AND provider='stripe' AND plan='pro'").get(details?.metadata?.order_id || '');
    if (!order) return { received:true };
    const line = obj.lines?.data?.find(item=> item.period?.end > item.period?.start && item.amount > 0);
    if (!line || obj.currency !== 'kzt' || obj.amount_paid !== order.amount*100 || obj.status !== 'paid') fail('Детали счёта расходятся с подпиской.');
    settle(db,order,'stripe:'+obj.id,{...line.period, customer:obj.customer, subscription:details.subscription || obj.subscription});
  }
  return { received:true };
}
async function notifyAdmin(db,id) {
  const endpoint = env().ADMIN_WEBHOOK_URL;
  if (!endpoint) return;
  const record = db.prepare('SELECT r.*,n.id AS notification_id FROM billing_requests r JOIN admin_notifications n ON n.request_id=r.id WHERE r.id=? AND n.delivered IS NULL').get(id);
  if (!record) return;
  try {
    if (new URL(endpoint).protocol !== 'https:') return;
    db.prepare('UPDATE admin_notifications SET attempts=attempts+1 WHERE request_id=?').run(id);
    const resp = await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':record.notification_id},redirect:'error',
      body:JSON.stringify({event:record.kind,id:record.id,details:JSON.parse(record.details)}),signal:AbortSignal.timeout(3500)});
    if (resp.ok) db.prepare('UPDATE admin_notifications SET delivered=? WHERE request_id=?').run(nowSeconds(),id);
  } catch { /* Durable admin inbox retains every request for follow-up. */ }
}
function saveRequest(db,user,data,kind) {
  const key = requestKey(data);
  const existing = db.prepare('SELECT id,kind FROM billing_requests WHERE user_id=? AND request_key=?').get(user.id,key);
  if (existing) {
    if (existing.kind !== kind) fail('Параметры заявки изменились.',409);
    return existing.id;
  }
  let details;
  if (kind === 'invoice') {
    const taxId = requiredText(data.taxId,16,'ИИН / БИН / ИНН');
    if (!/^\d{10}$|^\d{12}$/.test(taxId)) fail('Укажите 10 или 12 цифр в налоговом номере.');
    details = {...quote(data),company:requiredText(data.company,120,'Компания'),taxId,email:user.email,
      supplier: {
        name:env().INVOICE_COMPANY || '', taxId:env().INVOICE_TAX_ID || '',
        bank:env().INVOICE_BANK || '', iban:env().INVOICE_IBAN || '', bic:env().INVOICE_BIC || ''
      }, sandbox:sandbox()};
  } else {
    const volume = Number(data.volume);
    if (!Number.isSafeInteger(volume) || volume<1 || volume>1000000) fail('Укажите объём от 1 до 1 000 000.');
    const shop = requiredText(data.shop,500,'Ссылка на магазин');
    try { if (!['https:','http:'].includes(new URL(shop).protocol)) fail('Укажите адрес магазина.'); } catch { fail('Введите ссылку на магазин или канал.'); }
    details = {name:requiredText(data.name,100,'Имя'),contact:requiredText(data.contact,150,'Telegram / WhatsApp'),shop,volume,email:user.email};
  }
  const id=randomUUID();
  atomic(db,()=>{
    db.prepare('INSERT INTO billing_requests VALUES(?,?,?,?,?,?)').run(id,user.id,key,kind,JSON.stringify(details),nowSeconds());
    db.prepare('INSERT INTO admin_notifications(id,request_id,created) VALUES(?,?,?)').run(randomUUID(),id,nowSeconds());
  });
  return id;
}
export async function billingRoute(ctx) {
  const {path,method,db,user} = ctx, data = ctx.data || {};
  if (!path.startsWith('/api/billing')) return undefined;
  if (path === '/api/billing/webhook/stripe' && method === 'POST') return webhook(ctx);
  if (!user) fail('Войдите, чтобы продолжить.',401);
  if (path === '/api/billing' && method === 'GET') return state(db,user.id);
  if (method !== 'POST') fail('Метод не поддерживается.',405);
  if (path === '/api/billing/quote') return quote(data);
  if (path === '/api/billing/order') return createCheckout(db,user,data);
  if (path === '/api/billing/confirm') {
    if (!sandbox()) fail('Тестовая касса отключена.',403);
    const order = db.prepare("SELECT * FROM billing_orders WHERE id=? AND user_id=? AND provider='sandbox'").get(String(data.id || ''),user.id);
    if (!order) fail('Заказ не найден.',404);
    if (order.plan === 'pro' && order.status !== 'paid' && reconcileSubscription(db,user.id)) fail('Подписка уже действует.',409);
    settle(db,order,'sandbox:'+order.id);
    return state(db,user.id);
  }
  if (path === '/api/billing/portal') {
    const sub = db.prepare('SELECT customer_id FROM subscriptions WHERE user_id=?').get(user.id);
    if (sandbox() || !sub?.customer_id) fail('Кабинет Stripe недоступен.',400);
    const session = await stripe('billing_portal/sessions',{customer:sub.customer_id,return_url:origin()+'/?checkout=return'});
    return {url:session.url};
  }
  if (path === '/api/billing/lead' || path === '/api/billing/invoice') {
    const id = saveRequest(db,user,data,path.endsWith('/lead') ? 'lead' : 'invoice');
    await notifyAdmin(db,id);
    return {id};
  }
  fail('Маршрут не найден.',404);
}

// Bank transfers are reconciled by the operator using the reference on the bank statement.
// This function is deliberately available only in the server process and local operator CLI.
export function recordBankTransfer(db, requestId, bankReference, amount) {
  const reference=requiredText(bankReference,120,'Номер банковской операции');
  return atomic(db,()=>{
    const req=db.prepare("SELECT * FROM billing_requests WHERE id=? AND kind='invoice'").get(requestId);
    if (!req) fail('Счёт не найден.',404);
    const item=JSON.parse(req.details);
    if (amount!==item.amount) fail('Полученная сумма расходится со счётом.');
    const ref=(item.sandbox?'sandbox-wire:':'wire:')+reference;
    const existing=db.prepare('SELECT id,order_id FROM transactions WHERE provider_ref=? OR order_id=?').get(ref,requestId);
    if (existing) {
      if (existing.order_id!==requestId) fail('Банковская операция уже связана с другим счётом.',409);
      return {transactionId:existing.id};
    }
    if (item.plan==='pro' && reconcileSubscription(db,req.user_id)) fail('Подписка уже оплачена. Требуется сверка поступления.',409);
    const provider=item.sandbox?'sandbox':'bank';
    db.prepare(`INSERT INTO billing_orders(id,user_id,request_key,plan,term,amount,promo,method,provider,status,created)
      VALUES(?,?,?,?,?,?,?,'invoice',?,'pending',?)`).run(requestId,req.user_id,'invoice_'+requestId,item.plan,item.term,item.amount,item.promo,provider,nowSeconds());
    const order=db.prepare('SELECT * FROM billing_orders WHERE id=?').get(requestId);
    settle(db,order,ref);
    return {transactionId:db.prepare('SELECT id FROM transactions WHERE provider_ref=?').get(ref).id};
  });
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [file,command,...args]=process.argv.slice(2);
  if (!file || !existsSync(file) || !['inbox','retry-notifications','record-transfer'].includes(command)) {
    console.error('node backend/billing.mjs <sqlite-file> inbox | retry-notifications | record-transfer <invoice-id> <bank-reference> <amount-KZT>');
    process.exitCode=1;
  } else {
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(file);
    try {
      if (command==='inbox') {
        const rows=db.prepare(`SELECT r.id,r.created,r.kind,r.details,n.delivered AS webhook_delivered FROM billing_requests r
          JOIN admin_notifications n ON n.request_id=r.id ORDER BY r.created DESC LIMIT 100`).all();
        console.log(JSON.stringify(rows.map(r=>({...r,details:JSON.parse(r.details)})),null,2));
      } else if (command==='retry-notifications') {
        if (!env().ADMIN_WEBHOOK_URL) fail('Укажите ADMIN_WEBHOOK_URL.');
        for (const row of db.prepare('SELECT request_id FROM admin_notifications WHERE delivered IS NULL ORDER BY created LIMIT 100').all())
          await notifyAdmin(db,row.request_id);
        console.log('В очереди:',db.prepare('SELECT count(*) AS n FROM admin_notifications WHERE delivered IS NULL').get().n);
      } else {
        console.log(recordBankTransfer(db,args[0],args[1],Number(args[2])));
      }
    } catch (error) {console.error(error.message);process.exitCode=1;}
    finally {db.close();}
  }
}
