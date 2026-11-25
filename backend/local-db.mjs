import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {initBilling,billingRoute,reconcileSubscription,consumeCredit} from './billing.mjs';

export function localStore(filename) {
 const db=new DatabaseSync(filename);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 initBilling(db);
 const transaction=(fn)=>{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}};
 return {
  first:(sql,args=[])=>db.prepare(sql).get(...args),
  all:(sql,args=[])=>db.prepare(sql).all(...args),
  run:(sql,args=[])=>db.prepare(sql).run(...args),
  batch:items=>transaction(()=>items.forEach(([sql,args])=>db.prepare(sql).run(...args))),
  complete:(uid,id,name,input,pack,now)=>transaction(()=>{
   if(!consumeCredit(db,uid))throw Object.assign(new Error('Баланс закончился. Пополните счёт.'),{status:402});
   db.prepare('INSERT INTO projects(id,user_id,name,input,pack,updated) VALUES(?,?,?,?,?,?)').run(id,uid,name,input,pack,now);
   db.prepare("UPDATE generations SET status='done' WHERE id=?").run(id);
  }),
  refreshQuota:uid=>reconcileSubscription(db,uid),
  billing:args=>billingRoute({...args,db,request:{headers:Object.fromEntries(args.request.headers)},raw:Buffer.from(args.raw)}),
  close:()=>db.close()
 };
}

