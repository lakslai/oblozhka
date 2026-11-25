import {beginIdentity, finishIdentity, identityProviders} from './identity.mjs';
import {generatePack, generationStatus, rewriteParagraph} from './generate.mjs';
const enc = new TextEncoder();
const seconds = () => Math.floor(Date.now()/1000);
const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
const random = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => toHex(await crypto.subtle.digest('SHA-256',enc.encode(value)));
const hashPassword = async (password,salt) => {
 const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
 return toHex(await crypto.subtle.deriveBits({name:'PBKDF2',salt:enc.encode(salt),iterations:100000,hash:'SHA-256'},key,256));
};
function equal(a,b){if(a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0}
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
function reply(payload,status=200){return Response.json(payload,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
function cookie(req,token,age){return 'ob_session='+token+'; HttpOnly; SameSite=Lax; Path=/; Max-Age='+age+(new URL(req.url).protocol==='https:'?'; Secure':'')}
const cookieToken = req => req.headers.get('Cookie')?.match(/(?:^|;\s*)ob_session=([0-9a-f]{64})(?:;|$)/)?.[1];
async function startSession(ctx,userId,response) {
 const token=random();
 await ctx.batch([['DELETE FROM sessions WHERE expires<?',[seconds()]],['INSERT INTO sessions VALUES(?,?,?)',[await digest(token),userId,seconds()+2592000]]]);
 response.headers.append('Set-Cookie',cookie(ctx.request,token,2592000));
 return response;
}
async function limit(ctx,name,hits,window){
 const now=seconds(), key=await digest(name+'|'+ctx.ip+'|'+Math.floor(now/window));
 const row=await ctx.first('INSERT INTO rate_windows(key,hits,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits',[key,now+window]);
 if(row.hits>hits)fail('Слишком много попыток. Повторите позже.',429);
 if(row.hits===1)await ctx.run('DELETE FROM rate_windows WHERE expires<?',[now]);
}
async function inputBody(req){
 if(!req.headers.get('Content-Type')?.includes('application/json'))fail('Ожидается JSON.',415);
 const max=17*1024*1024;
 if(Number(req.headers.get('Content-Length'))>max)fail('Файл слишком большой.',413);
 const stream=req.body?.getReader();if(!stream)fail('Пустой запрос.');
 const decoder=new TextDecoder();let total=0,body='';
 while(true){const {done,value}=await stream.read();if(done)break;total+=value.length;if(total>max){await stream.cancel();fail('Файл слишком большой.',413)}body+=decoder.decode(value,{stream:true})}
 try{const raw=body+decoder.decode();const data=JSON.parse(raw);if(!data||Array.isArray(data)||typeof data!=='object')throw Error();return {raw,data}}catch{fail('Неверный формат запроса.')}
}
function profile(user){return {id:user.id,email:user.identity&&user.email.endsWith('@identity.invalid')?user.identity.split(':')[0]:user.email,credits:user.credits,prefs:JSON.parse(user.prefs)}}
function unpack(row){return {id:row.id,name:row.name,input:JSON.parse(row.input),pack:JSON.parse(row.pack),updated:row.updated,revision:row.revision}}
function validatePack(pack){if(!pack||!['card','script','localization','srt'].every(k=>typeof pack[k]==='string'&&pack[k].length<=160000))fail('Проверьте текст результата.')}
function shape(data){
 return {source:String(data.source||'').slice(0,16000),mode:data.mode,media:data.media||undefined,
 platforms:data.platforms,langs:data.langs,sourceLang:data.sourceLang,tone:data.tone,brand:String(data.brand||'').slice(0,1200)};
}
async function saveGeneration(ctx,user,data){
 const input=shape(data), id=crypto.randomUUID(), key=data.key;
 if(typeof key!=='string'||!/^[-a-zA-Z0-9_]{8,90}$/.test(key))fail('Отсутствует идентификатор генерации.');
 let existing=await ctx.first('SELECT id,status FROM generations WHERE user_id=? AND request_key=?',[user.id,key]);
 if(existing){if(existing.status==='done')return unpack(await ctx.first('SELECT * FROM projects WHERE id=?',[existing.id]));fail('Эта генерация уже выполняется.',409)}
 if(user.credits<1)fail('Пополните баланс генераций.',402);
 if(!ctx.modes().modes.some(m=>m.id===input.mode&&m.configured))fail('Выбранный режим недоступен.',503);
 const claimed=await ctx.first("INSERT INTO generations VALUES(?,?,?,'pending',?) ON CONFLICT(user_id,request_key) DO NOTHING RETURNING id",[id,user.id,key,seconds()]);
 if(!claimed)fail('Генерация уже начата.',409);
 try{
  const pack=await ctx.generate(input);validatePack(pack);
  if(input.media){await ctx.saveMedia(id,input.media);const {data:bytes,...metadata}=input.media;input.media=metadata}
  const name=(input.source.trim().split(/[\n.!?]/)[0]||input.media?.name||'Новый проект').slice(0,80);
  await ctx.complete(user.id,id,name,JSON.stringify(input),JSON.stringify(pack),seconds());
  return unpack(await ctx.first('SELECT * FROM projects WHERE user_id=? AND id=?',[user.id,id]));
 }catch(error){await ctx.run("DELETE FROM generations WHERE id=? AND status='pending'",[id]);await ctx.deleteMedia(id).catch(()=>{});throw error}
}
export async function api(ctx){
 const req=ctx.request,url=new URL(req.url),path=url.pathname,method=req.method;
 try{
  const webhook=path==='/api/billing/webhook/stripe';
  if(method==='POST'&&!webhook&&req.headers.has('Origin')&&req.headers.get('Origin')!==url.origin)fail('Недопустимый источник запроса.',403);
  const {data,raw}=method==='POST'?await inputBody(req):{data:{},raw:''};
  const token=cookieToken(req);
  const getUser=async()=>token?ctx.first('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires>?',[await digest(token),seconds()]):null;
  let user=await getUser();
  const social=path.match(/^\/api\/auth\/(google|telegram)\/(start|callback)$/);
  if(social&&method==='GET'){
   try{
    if(!identityProviders(ctx.env)[social[1]])fail('Провайдер входа не настроен.',503);
    if(social[2]==='start'){
     await limit(ctx,'oauth',24,600);
     const {url:destination,cookie:flow}=await beginIdentity(social[1],ctx.env,async(k,r)=>ctx.batch([['DELETE FROM oauth_states WHERE expires<?',[seconds()]],['INSERT INTO oauth_states VALUES(?,?,?)',[k,JSON.stringify(r),r.expires]]]));
     return new Response(null,{status:302,headers:{Location:destination,'Set-Cookie':flow,'Cache-Control':'no-store'}})
    }
    const socialUser=await finishIdentity(social[1],ctx.env,req,async key=>{const r=await ctx.first('DELETE FROM oauth_states WHERE key=? RETURNING record',[key]);return r?JSON.parse(r.record):null});
    const identifier=social[1]+':'+socialUser.subject;
    const internalEmail=(await digest(identifier))+'@identity.invalid';
    await ctx.run('INSERT INTO users(id,email,identity) VALUES(?,?,?) ON CONFLICT(identity) DO NOTHING',[crypto.randomUUID(),internalEmail,identifier]);
    const found=await ctx.first('SELECT id FROM users WHERE identity=?',[identifier]);
    const response=new Response(null,{status:302,headers:{Location:'/#studio','Set-Cookie':socialUser.cookie,'Cache-Control':'no-store'}});
    return startSession(ctx,found.id,response);
   }catch(e){return new Response(null,{status:302,headers:{Location:'/?auth_error=1#studio','Cache-Control':'no-store'}})}
  }
  if(method==='GET'&&path==='/api/config')return reply({generation:ctx.modes(),social:identityProviders(ctx.env)});
  if(method==='POST'&&['/api/register','/api/login'].includes(path)){
   await limit(ctx,'auth',30,900);
   const email=String(data.email||'').trim().toLowerCase(),password=data.password;
   if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||email.length>254||email.endsWith('@identity.invalid')||typeof password!=='string'||password.length<8||password.length>128)fail('Введите email и пароль от 8 до 128 символов.');
   let account;
   if(path==='/api/register'){
    const salt=random(), stored=salt+'$'+await hashPassword(password,salt);
    account=await ctx.first('INSERT INTO users(id,email,password) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING RETURNING id',[crypto.randomUUID(),email,stored]);
    if(!account)fail('Этот email уже зарегистрирован.',409);
   }else{
    account=await ctx.first('SELECT id,password FROM users WHERE email=?',[email]);
    const [salt,hash]=(account?.password||('0'.repeat(64)+'$'+'0'.repeat(64))).split('$');
    if(!equal(await hashPassword(password,salt),hash)||!account?.password)fail('Неверный email или пароль.',401);
   }
   return startSession(ctx,account.id,reply({ok:true}));
  }
  if(path==='/api/logout'&&method==='POST'){
   if(token)await ctx.run('DELETE FROM sessions WHERE hash=?',[await digest(token)]);
   const response=reply({ok:true});response.headers.set('Set-Cookie',cookie(req,'',0));return response
  }
  if(!user&&!webhook)fail('Войдите в аккаунт.',401);
  if(user){await ctx.refreshQuota(user.id);user=await getUser()}
  if(path.startsWith('/api/billing')){const value=await ctx.billing({path,method,data,raw,user,request:req});if(value!==undefined)return reply(value)}
  if(path==='/api/state'&&method==='GET')return reply({user:profile(user),projects:await ctx.all('SELECT id,name,updated FROM projects WHERE user_id=? ORDER BY updated DESC',[user.id])});
  if(path==='/api/preferences'&&method==='POST'){
   const prefs={brand:String(data.brand||'').slice(0,1200),tone:String(data.tone||'Дружелюбный').slice(0,80),template:String(data.template||'').slice(0,100)};
   await ctx.run('UPDATE users SET prefs=? WHERE id=?',[JSON.stringify(prefs),user.id]);return reply(prefs)
  }
  if(path==='/api/generate'&&method==='POST'){await limit(ctx,'gen:'+user.id,30,600);return reply(await saveGeneration(ctx,user,data))}
  const route=path.match(/^\/api\/projects\/([a-f0-9-]+)(?:\/(media|rewrite))?$/);
  if(route){
   const row=await ctx.first('SELECT * FROM projects WHERE id=? AND user_id=?',[route[1],user.id]);if(!row)fail('Проект не найден.',404);
   const project=unpack(row);
   if(method==='GET'&&route[2]==='media'){if(!project.input.media)fail('Исходник не найден.',404);return ctx.readMedia(row.id,project.input.media.mime)}
   if(method==='GET'&&!route[2])return reply(project);
   if(method==='POST'&&!route[2]){
    validatePack(data.pack);
    const updated=await ctx.first('UPDATE projects SET pack=?,name=?,updated=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=? RETURNING *',[JSON.stringify(data.pack),String(data.name||row.name).slice(0,100),seconds(),row.id,user.id,data.revision]);
    if(!updated)fail('Проект изменён в другой вкладке. Откройте его заново перед сохранением.',409);
    return reply(unpack(updated))
   }
   if(method==='POST'&&route[2]==='rewrite'){
    await limit(ctx,'rewrite:'+user.id,24,600);
    const paragraph=String(data.paragraph||'').trim();if(!paragraph||paragraph.length>4000)fail('Выделите до 4000 символов.');
    return reply({text:await ctx.rewrite({...project.input,media:undefined,paragraph,instruction:String(data.instruction||'').slice(0,500),section:String(data.section||'card')})})
   }
  }
  fail('Страница не найдена.',404);
 }catch(e){const status=e.status||e.statusCode||500;if(status>=500)console.error('API',method,path,e.name);return reply({error:status===500?'Ошибка сервера. Повторите попытку.':e.message},status)}
}
export const defaultModel={modes:generationStatus,generate:generatePack,rewrite:rewriteParagraph};

