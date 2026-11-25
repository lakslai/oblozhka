import {readFile} from 'node:fs/promises';
import {hostedBilling,refreshQuota} from '../hosted/billing.mjs';

const schema = new URL('./postgres.sql',import.meta.url);
const searchPath = 'SET LOCAL search_path TO oblozhka, pg_catalog';

// All SQL templates passed here are private application source. User data goes in bound parameters.
export function postgresStatement(sql) {
  let index=0;
  return sql.replace(/'(?:''|[^'])*'|\?/g,token=>token==='?'?'$'+(++index):token)
    .replace(/\bt\.rowid\b/g,'t.id').replace(/\browid\b/g,'id')
    .replace('DO UPDATE SET hits=hits+1','DO UPDATE SET hits=rate_windows.hits+1');
}
function error(message,status) {return Object.assign(new Error(message),{status});}

// A small D1-shaped interface lets Cloudflare and Postgres use the same validated sandbox checkout.
function billingDatabase(execute) {
  return {
    prepare(sql){return {bind(...values){
      const item=[sql,values];
      return {
        item,
        first:async()=>(await execute([item]))[0].results[0] || null,
        run:async()=>(await execute([item]))[0]
      };
    }};},
    batch:statements=>execute(statements.map(s=>s.item))
  };
}
async function statements(client,items) {
  const results=[];
  for(const [sql,values=[]] of items) {
    const r=await client.query(postgresStatement(sql),values);
    results.push({results:r.rows,changes:r.rowCount});
  }
  return results;
}
async function withTransaction(pool,fn,scope=null) {
  const client=await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    await client.query(searchPath);
    if(scope!==null)await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[scope]);
    const result=await fn(client);
    await client.query('COMMIT');
    return result;
  } catch(e) {
    try {await client.query('ROLLBACK');}catch(rollbackError){releaseError=rollbackError;}
    throw e;
  } finally {client.release(releaseError);}
}
export async function migratePostgres(pool) {
  const sql=await readFile(schema,'utf8');
  await withTransaction(pool,async c=>{
    // One schema migration can run even when several Node instances start simultaneously.
    await c.query('SELECT pg_advisory_xact_lock(19200911,107)');
    await c.query('CREATE SCHEMA IF NOT EXISTS oblozhka');
    await c.query('CREATE TABLE IF NOT EXISTS oblozhka.migrations(version integer PRIMARY KEY)');
    if((await c.query('SELECT version FROM oblozhka.migrations WHERE version=1')).rowCount)return;
    await c.query(sql);
    await c.query('INSERT INTO oblozhka.migrations(version) VALUES(1)');
  });
}
export function postgresStore(pool,env=process.env) {
  const execute=(items,userId=null)=>withTransaction(pool,c=>statements(c,items),userId);
  const scopedDb=uid=>billingDatabase(items=>execute(items,uid));
  return {
    first:async(sql,args=[])=>(await execute([[sql,args]]))[0].results[0] || null,
    all:async(sql,args=[])=>(await execute([[sql,args]]))[0].results,
    run:async(sql,args=[])=>(await execute([[sql,args]]))[0],
    batch:execute,
    refreshQuota:uid=>refreshQuota(scopedDb(uid),uid),
    billing:ctx=>hostedBilling({...ctx,env,db:scopedDb(ctx.user?.id || null)}),
    complete:(uid,id,name,input,pack,now)=>withTransaction(pool,async c=>{
      const db=billingDatabase(items=>statements(c,items));
      await refreshQuota(db,uid);
      const pending=await c.query("UPDATE generations SET status='done' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING id",[id,uid]);
      if(!pending.rowCount)throw error('Проект уже обработан.',409);
      const debit=await c.query('UPDATE users SET credits=credits-1 WHERE id=$1 AND credits>0 RETURNING id',[uid]);
      if(!debit.rowCount)throw error('Баланс закончился. Пополните счёт.',402);
      await c.query('INSERT INTO projects(id,user_id,name,input,pack,updated) VALUES($1,$2,$3,$4,$5,$6)',[id,uid,name,input,pack,now]);
    },uid),
    close:()=>pool.end()
  };
}
export async function createPostgres(url,env=process.env) {
  if(!url)throw Error('Укажите DATABASE_URL для PostgreSQL.');
  const {Pool}=await import('pg');
  const pool=new Pool({connectionString:url,max:8,connectionTimeoutMillis:10000,idleTimeoutMillis:30000});
  // A dropped idle pooled connection is removed by pg; the next request opens another one.
  pool.on('error',e=>console.error('PostgreSQL pool:',e.code || e.name));
  try {await migratePostgres(pool);return postgresStore(pool,env);}
  catch(e){await pool.end();throw e;}
}
