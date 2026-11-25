const nowSeconds = () => Math.floor(Date.now()/1000);
const money = {pack:4990, month:14990, year:143904};
function fail(message,status=400) {throw Object.assign(new Error(message),{status});}
function field(value,label,max) {
  if (typeof value!=='string' || !value.trim() || value.trim().length>max) fail('Проверьте поле «'+label+'».');
  return value.trim();
}
function key(data) {
  if (typeof data.key!=='string'|| !/^[\w-]{8,90}$/.test(data.key)) fail('Обновите форму и повторите запрос.');
  return data.key;
}
function quote(data,env) {
  if (!['pack','pro'].includes(data.plan)) fail('Выберите тариф.');
  const term=data.plan==='pack'?'once':data.term;
  if (data.plan==='pro' && !['month','year'].includes(term)) fail('Выберите период подписки.');
  const promo=String(data.promo || '').trim().toUpperCase();
  if (promo && promo!==String(env.BILLING_PROMO_CODE || 'START10').toUpperCase()) fail('Промокод не найден.');
  const base=data.plan==='pack'?money.pack:money[term];
  return {plan:data.plan,term,base,amount:promo?Math.round(base*.9):base,promo,units:data.plan==='pack'?20:100};
}
const statement = (db,sql,...args) => db.prepare(sql).bind(...args);
function monthsAfter(stamp,offset) {
  const date=new Date(stamp*1000), day=date.getUTCDate();
  date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+offset);
  const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
  date.setUTCDate(Math.min(day,last));
  return Math.floor(+date/1000);
}
function currentMonth(stamp,now) {
  const a=new Date(stamp*1000),b=new Date(now*1000);
  const delta=(b.getUTCFullYear()-a.getUTCFullYear())*12+b.getUTCMonth()-a.getUTCMonth();
  return monthsAfter(stamp,Math.max(0,delta-(monthsAfter(stamp,delta)>now?1:0)));
}
export async function refreshQuota(db,userId,now=nowSeconds()) {
  const sub=await statement(db,'SELECT * FROM subscriptions WHERE user_id=?',userId).first();
  if(!sub)return null;
  const active=now<sub.paid_end;
  const start=active?currentMonth(sub.paid_start,now):sub.paid_end;
  if(start>sub.period_start){
    // The predicate rejects stale work after a payment or a concurrent refresh.
    // The trigger reads OLD.remaining at write time, preserving any concurrent generation.
    await statement(db,`UPDATE subscriptions SET period_start=?,remaining=?
      WHERE user_id=? AND order_id=? AND period_start<?`,start,active?100:0,userId,sub.order_id,start).run();
  }
  return statement(db,'SELECT * FROM subscriptions WHERE user_id=? AND paid_end>?',userId,now).first();
}
async function state(db,userId){
  await refreshQuota(db,userId);
  const [user,sub,history,requests]=await db.batch([
    statement(db,'SELECT credits FROM users WHERE id=?',userId),
    statement(db,'SELECT term,paid_end AS until,remaining FROM subscriptions WHERE user_id=? AND paid_end>?',userId,nowSeconds()),
    statement(db,`SELECT t.id,t.amount,t.units,t.provider,t.created,o.plan,o.term FROM transactions t
      JOIN billing_orders o ON t.order_id=o.id WHERE t.user_id=? ORDER BY t.created DESC,t.rowid DESC LIMIT 100`,userId),
    statement(db,'SELECT id,kind,created,details FROM billing_requests WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 20',userId)
  ]);
  return {mode:'sandbox',credits:user.results[0].credits,subscription:sub.results[0]?{...sub.results[0],managed:false}:null,
    transactions:history.results,requests:requests.results.map(({details,...r})=>r.kind==='invoice'?{...r,invoice:JSON.parse(details)}:r)};
}
async function order(db,user,data,env) {
  const q=quote(data,env),k=key(data),id=crypto.randomUUID();
  if(q.plan==='pro'&&await refreshQuota(db,user.id)){
    const prior=await statement(db,'SELECT id FROM billing_orders WHERE user_id=? AND request_key=?',user.id,k).first();
    if (!prior)fail('Подписка уже действует.',409);
  }
  const [,selected]=await db.batch([
    statement(db,`INSERT INTO billing_orders(id,user_id,request_key,plan,term,amount,promo,created) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,request_key) DO NOTHING`,id,user.id,k,q.plan,q.term,q.amount,q.promo,nowSeconds()),
    statement(db,`SELECT o.*,CASE WHEN t.id IS NULL THEN 'pending' ELSE 'paid' END AS status FROM billing_orders o
      LEFT JOIN transactions t ON t.order_id=o.id WHERE o.user_id=? AND o.request_key=?`,user.id,k)
  ]);
  const found=selected.results[0];
  if (found.plan!==q.plan||found.term!==q.term||found.amount!==q.amount)fail('Условия заказа изменились.',409);
  return {id:found.id,amount:found.amount,status:found.status,url:null};
}
async function confirm(db,user,data){
  const id=field(data.id,'Заказ',100);
  const row=await statement(db,'SELECT * FROM billing_orders WHERE user_id=? AND id=?',user.id,id).first();
  if(!row)fail('Заказ не найден.',404);
  const now=nowSeconds(),end=row.plan==='pro'?monthsAfter(now,row.term==='year'?12:1):null;
  try {
    await statement(db,`INSERT INTO transactions(id,order_id,user_id,amount,units,created,paid_end)
      SELECT ?,o.id,o.user_id,o.amount,CASE WHEN o.plan='pack' THEN 20 ELSE 100 END,?,?
      FROM billing_orders o WHERE o.id=? AND o.user_id=? AND NOT EXISTS(SELECT 1 FROM transactions WHERE order_id=o.id)`,
      crypto.randomUUID(),now,end,row.id,user.id).run();
  } catch(error) {
    if (String(error.message).includes('active_subscription')||String(error.cause?.message).includes('active_subscription')) fail('Подписка уже действует.',409);
    throw error;
  }
  return state(db,user.id);
}
function details(kind,user,data,env){
  if(kind==='invoice'){
    const taxId=field(data.taxId,'ИИН / БИН / ИНН',16);
    if(!/^(?:\d{10}|\d{12})$/.test(taxId)) fail('Укажите 10 или 12 цифр в налоговом номере.');
    return {...quote(data,env),taxId,company:field(data.company,'Компания',120),email:user.email,sandbox:true};
  }
  const shop=field(data.shop,'Ссылка на магазин',500), volume=Number(data.volume);
  try {if(!['https:','http:'].includes(new URL(shop).protocol))throw Error();}catch{fail('Укажите ссылку на магазин или канал.');}
  if(!Number.isSafeInteger(volume)||volume<1||volume>1e6) fail('Укажите количество от 1 до 1 000 000.');
  return {name:field(data.name,'Имя',100),contact:field(data.contact,'Telegram / WhatsApp',150),shop,volume,email:user.email};
}
export async function deliverAdminNotification(db,env,id){
  if(!env.ADMIN_WEBHOOK_URL)return;
  const r=await statement(db,`SELECT r.* FROM billing_requests r JOIN admin_notifications n ON n.request_id=r.id
    WHERE r.id=? AND n.delivered IS NULL`,id).first();
  if(!r)return;
  try {
    if(new URL(env.ADMIN_WEBHOOK_URL).protocol!=='https:')return;
    await statement(db,'UPDATE admin_notifications SET attempts=attempts+1 WHERE request_id=?',id).run();
    const resp=await fetch(env.ADMIN_WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':id},
      body:JSON.stringify({event:r.kind,id,details:JSON.parse(r.details)}),redirect:'error',signal:AbortSignal.timeout(3500)});
    if(resp.ok) await statement(db,'UPDATE admin_notifications SET delivered=? WHERE request_id=?',nowSeconds(),id).run();
  } catch { /* The durable admin inbox retains undelivered notifications. */ }
}
async function saveRequest(db,user,kind,data,env){
  const k=key(data),fields=details(kind,user,data,env);
  const [,selected]=await db.batch([
    statement(db,`INSERT INTO billing_requests(id,user_id,request_key,kind,details,created) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,request_key) DO NOTHING`,crypto.randomUUID(),user.id,k,kind,JSON.stringify(fields),nowSeconds()),
    statement(db,'SELECT id,kind FROM billing_requests WHERE user_id=? AND request_key=?',user.id,k)
  ]);
  const row=selected.results[0];
  if(row.kind!==kind) fail('Параметры заявки изменились.',409);
  await deliverAdminNotification(db,env,row.id);
  return {id:row.id};
}
export async function hostedBilling({path,method,data={},user,db,env={}}){
  if (path!=='/api/billing'&&!path.startsWith('/api/billing/')) return undefined;
  if(!user)fail('Войдите в кабинет.',401);
  if(path==='/api/billing'&&method==='GET')return state(db,user.id);
  if(method!=='POST')fail('Метод не поддерживается.',405);
  if(path==='/api/billing/order') return order(db,user,data,env);
  if(path==='/api/billing/confirm') return confirm(db,user,data);
  if(path==='/api/billing/quote') return quote(data,env);
  if(path==='/api/billing/lead'||path==='/api/billing/invoice')return saveRequest(db,user,path.split('/').pop(),data,env);
  fail('Маршрут не найден.',404);
}
