import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {resolve,extname,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {api,defaultModel} from './backend/app.mjs';
import {localStore} from './backend/local-db.mjs';

const root=dirname(fileURLToPath(import.meta.url));
if(existsSync(resolve(root,'.env')))process.loadEnvFile(resolve(root,'.env'));
const port=Number(process.env.PORT||8787),host=process.env.HOST||'127.0.0.1';
const dir=resolve(process.env.DATA_DIR||resolve(root,'data'));
const site=resolve(root,'dist/client');
if(!existsSync(resolve(site,'index.html')))throw Error('Сначала соберите интерфейс: npm install && npm run build');
await mkdir(resolve(dir,'media'),{recursive:true});
const store=process.env.DATABASE_URL?await (await import('./backend/postgres.mjs')).createPostgres(process.env.DATABASE_URL):localStore(resolve(dir,'oblozhka.sqlite'));
const thatOrigin=process.env.PUBLIC_ORIGIN||process.env.RENDER_EXTERNAL_URL||'http://'+host+':'+port;
const context={...store,...defaultModel,env:{...process.env,PUBLIC_ORIGIN:thatOrigin},
 saveMedia:async(id,media)=>writeFile(resolve(dir,'media',id),Buffer.from(media.data,'base64')),
 readMedia:async(id,type)=>new Response(await readFile(resolve(dir,'media',id)),{headers:{'Content-Type':type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}}),
 deleteMedia:async id=>unlink(resolve(dir,'media',id)).catch(err=>{if(err.code!=='ENOENT')throw err})
};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,thatOrigin);
  let result;
  if(url.pathname.startsWith('/api/')){
   const options={method:req.method,headers:req.headers};
   if(!['GET','HEAD'].includes(req.method)){options.body=Readable.toWeb(req);options.duplex='half'}
   const request=new Request(url,options);
   result=await api({...context,request,ip:req.socket.remoteAddress||'local'});
  }else{
   const path=resolve(site,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
   if(!path.startsWith(site+sep)||!['GET','HEAD'].includes(req.method))return res.writeHead(404).end();
   try{result=new Response(await readFile(path),{headers:{'Content-Type':mime[extname(path)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'}})}
   catch{return res.writeHead(404).end()}
  }
  for(const [key,value] of result.headers){if(key!=='set-cookie')res.setHeader(key,value)}
  const cookies=result.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
  res.writeHead(result.status);if(req.method==='HEAD'||!result.body)return res.end();
  Readable.fromWeb(result.body).pipe(res);
 }catch(e){console.error('HTTP',e.name);if(!res.headersSent)res.writeHead(500);res.end()}
});
server.listen(port,host,()=>console.log('Oblozhka.kz  '+thatOrigin));
process.on('SIGTERM',()=>server.close(async()=>{await store.close();process.exit(0)}));


