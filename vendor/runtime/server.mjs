import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {appendFileSync,mkdirSync} from 'node:fs';
import {join as joinPath} from 'node:path';
import {fileURLToPath} from 'node:url';
const DBG=fileURLToPath(new URL('../.relay-debug.jsonl',import.meta.url));
const dbg=(kind,payload)=>{try{appendFileSync(DBG,JSON.stringify({t:new Date().toISOString(),kind,...payload})+'\n')}catch{}};
import {randomBytes,timingSafeEqual} from 'node:crypto';
import WebSocket,{WebSocketServer} from 'ws';
import {createDelegationBridge} from '@mossai/mosslive';
import {validateRequest,filterEvent} from './public-api.mjs';
const assets=new Set(['js/client-demo.js','js/product-view.js','js/public-session.js','js/speaker.js','js/playback.js','js/mic.js','js/pcm.js','js/capture-worklet.js','product/index.css','product/voice.css','product/client.css','product/orb-renderer.js','product/mosi-logo.png','product/index.html']);
const browserActions=new Set(['media.mode','mic_state','video.state','video.stream_focus','playback.chunk.completed','playback.completed','playback.stopped','session.update','conversation.item.create','response.create','ping']);
const loopback=h=>['localhost','127.0.0.1','[::1]'].includes(h);
function shortTitle(text){
 let t=String(text||'').replace(/\s+/g,' ').trim();
 t=t.replace(/^用户原话[:：]?\s*/,'').replace(/^用户(说|问)[:：]?\s*/,'');
 t=t.replace(/^[「“"']/,'').replace(/[」”"']$/,'');
 // Drop leading filler and politeness, but never split on commas: a task
 // like "啊，帮我查一下北京的天气" must keep its verb.
 const filler=/^(?:啊|哦|嗯|呃|诶|哎|那个|然后|还有|就是|好|帮我|帮|麻烦你|麻烦|请|你)[，,、。.．\s]*/;
 for(let i=0;i<6&&filler.test(t);i++)t=t.replace(filler,'');
 t=t.replace(/[吧呢啊啦呀]+$/,'');
 const m=t.match(/^[^。！？!?；;]{1,24}/);
 const cut=m?m[0]:t;
 const rest=t.slice(cut.length).replace(/^[。！？!?；;，,、\s]+/,'');
 const trimmed=cut.replace(/[。！？!?；;，,、\s]+$/,'').replace(/[吧呢啊啦呀]+$/,'').trim();
 return (trimmed+(rest?'…':''))||'后台任务';
}

export function taskTitle(data,apiKey='') {
 if(data?.purpose==='reasoning')return '正在思考';
 if(data?.purpose!=='task'||typeof data.objective!=='string')return '后台任务';
 const clean=data.objective.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim();
 const chars=Array.from(apiKey?clean.split(apiKey).join('[redacted]'):clean);
 return chars.length?chars.slice(0,40).join('')+(chars.length>40?'…':''):'后台任务';
}
export async function startLocalClient({listen='127.0.0.1:17860',url,apiKey,model,user,delegation='client',run,instructions,persona,token:fixedToken,frameAncestors='none',allowedOrigins=[],historyDir=null,onCallEnd=null,...runnerOptions}){
 const address=new URL(url),bind=new URL(`http://${listen}`);
 if(!loopback(bind.hostname)||!['client','none'].includes(delegation))throw Error('INVALID_LOCAL_CONFIGURATION');
 if((address.protocol!=='wss:'&&!(address.protocol==='ws:'&&loopback(address.hostname)))||address.username||address['pass'+'word']||address.search||address.hash)throw Error('PUBLIC_WSS_URL_REQUIRED');
 if(!apiKey||/[\r\n]/.test(apiKey))throw Error('API_KEY_REQUIRED');
 if(delegation==='client'){const probe=createDelegationBridge({run,...runnerOptions,send:()=>{}});await probe.close();}
 if(model)address.searchParams.set('model',model);if(user)address.searchParams.set('user',user);
 // Wrapper change: a caller may pin the connection token so an already-open
 // call page survives a relay restart instead of failing with a stale token.
 // Wrapper change: keep a local, append-only record of what both sides said
 // and which tasks were dispatched, so a call is reviewable after it ends.
 const historyFile=historyDir?joinPath(historyDir,`${new Date().toISOString().slice(0,10)}.jsonl`):null;
 const appendHistory=(kind,text)=>{if(!historyFile)return;try{mkdirSync(historyDir,{recursive:true});appendFileSync(historyFile,JSON.stringify({t:new Date().toISOString(),kind,text:String(text??'').slice(0,2000)})+'\n');}catch{}};
 const token=fixedToken||randomBytes(32).toString('hex'),wss=new WebSocketServer({noServer:true,maxPayload:16*1024*1024});
 let active,closing=false,cleanupError,closePromise;
 const server=createServer(async(req,res)=>{
  const reject=(code)=>{res.writeHead(code);res.end();};
  if(req.headers.host!==authority)return reject(403);
  if(req.method!=='GET')return reject(405);
  const path=new URL(req.url,`http://${authority}`).pathname,name=path==='/'?'product/index.html':path.slice(1);
  dbg('http-get',{path,ua:String(req.headers['user-agent']||'').slice(0,40),dest:req.headers['sec-fetch-dest']||''});
  if(path==='/report'){
   dbg('page-error',{message:String(new URL(req.url,`http://${authority}`).searchParams.get('m')||'').slice(0,400)});
   res.writeHead(204,{'Content-Type':'text/plain'});res.end();return;
  }
  if(!assets.has(name))return reject(404);
  try{const body=await readFile(new URL(`../web/${name}`,import.meta.url));
   res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'text/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':`default-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${frameAncestors}`});res.end(body);
  }catch{reject(500);}
 });
 let authority;
 server.on('upgrade',async(req,socket,head)=>{
  const reject=code=>{socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\n\r\n`);};
  const path=new URL(req.url,`http://${authority}`),given=Buffer.from(path.searchParams.get('token')??'');
  // Wrapper change: the call page may be served from the harness origin and
  // connect here cross-origin, so accept that origin as well.
  const allowed=new Set([`http://${authority}`,...allowedOrigins]);
  // Wrapper change: the harness desktop shell loads the UI from a custom
  // scheme (dsh-app://app), so the page origin is not an http URL. The
  // unguessable token plus the pinned Host header carry the authentication;
  // the origin is only logged.
  const originOk=allowed.has(req.headers.origin)||String(req.headers.origin||'').startsWith('dsh-app://');
  const ok=req.headers.host===authority&&originOk&&path.pathname==='/connect'&&given.length===token.length&&timingSafeEqual(given,Buffer.from(token));
  dbg('ws-upgrade',{ok,path:path.pathname,origin:String(req.headers.origin||''),host:String(req.headers.host||'')});
  if(!ok)return reject(403);
  // A new session may arrive while cancellation from the old one is settling.
  if(active?.stopping){
   let timeout;
   await Promise.race([active.complete,new Promise(resolve=>{timeout=setTimeout(resolve,10000);})]);
   clearTimeout(timeout);
  }
  if(socket.destroyed)return;
  if(closing)return reject(503);if(active)return reject(409);
  wss.handleUpgrade(req,socket,head,browser=>{
   const upstream=new WebSocket(address,{headers:{Authorization:`Bearer ${apiKey}`},followRedirects:false,handshakeTimeout:15000,maxPayload:16*1024*1024});
   const callLog=[];
   const recordHistory=(kind,text)=>{const entry={t:new Date().toISOString(),kind,text:String(text??'').slice(0,2000)};callLog.push(entry);appendHistory(kind,text);};
   let bridge,done,attached=false,ended=false;
   const complete=new Promise(r=>done=r);
   const record={complete,stop,get stopping(){return ended;}};active=record;
   const attachTimer=setTimeout(stop,15000);
   function stop(){
    if(ended)return;ended=true;clearTimeout(attachTimer);
    browser.terminate();upstream.terminate();
    Promise.resolve(bridge?.close()).catch(e=>{cleanupError=e;}).finally(()=>{
     if(active===record)active=null;done();
     if(onCallEnd&&callLog.length)Promise.resolve().then(()=>onCallEnd(callLog)).catch(()=>{});
    });
   }
   // UI notifications stay on the local connection and contain no executor output.
   const tasks=new Map(),receipts=new Map(),titles=new Map();
   function taskStatus(id,status){
    if(!id||ended)return;
    const previous=tasks.get(id);
    if(status==='queued'&&tasks.has(id))return;
    if(previous===status)return;
    if(['completed','failed','cancelled'].includes(previous))return;
    tasks.set(id,status);
    if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify({type:'demo.task',id,status,title:titles.get(id)||'后台任务'}));
   }
   // Every executor, including Pi, enters the same SDK bridge.
   if(delegation==='client')bridge=createDelegationBridge({...runnerOptions,
    run:async(task,context)=>{
     taskStatus(task.delegationId,'running');
     return run(task,context);
    },
    send:frame=>new Promise((resolve,reject)=>{
     if(upstream.readyState!==WebSocket.OPEN){reject(Error('CONNECTION_CLOSED'));return;}
     if(frame.status==='in_progress')taskStatus(frame.delegation_id,'progress');
     if(frame.status==='completed'||frame.status==='failed'){
      receipts.set(frame.event_id,{id:frame.delegation_id,status:frame.status});
      taskStatus(frame.delegation_id,'returning');
     }
     upstream.send(JSON.stringify(frame),error=>error?reject(error):resolve());
    }),
    onError:e=>{if(e.code!=='EXECUTOR_FAILED')stop();},
   });
   // Wrapper change: one async tool makes the DSH executor reachable for any
   // request the front model would otherwise answer from its own knowledge.
   const HOST_STATUS_TOOL={type:'function',name:'dsh_tasks',description:'查询当前语音任务的整体进展：哪些在跑、哪些已完成、各自结果摘要。用户问“进展怎么样了/有哪些任务”时调用。',parameters:{type:'object',properties:{},additionalProperties:false}};
   const taskLog=new Map();
   function statusText(){
    const running=[],finished=[];
    for(const [id,t] of taskLog){
     const title=Array.from(t.objective).slice(0,24).join('');
     if(t.status==='running')running.push(`「${title}」已进行 ${Math.max(1,Math.round((Date.now()-t.startedAt)/1000))} 秒`);
     else finished.push(`「${title}」${t.status==='failed'?'失败':'完成'}，结果：${Array.from(t.output||'').slice(0,60).join('')}`);
    }
    if(!running.length&&!finished.length)return '现在没有任何语音任务。';
    const parts=[];
    if(running.length)parts.push(`进行中 ${running.length} 个：`+running.join('；'));
    if(finished.length)parts.push(`已完成 ${finished.length} 个：`+finished.slice(-3).join('；'));
    return Array.from(parts.join('。')).slice(0,1900).join('');
   }
   const HOST_TOOL={type:'function',name:'dsh_task',description:'把需要查询、执行或涉及外部世界、实时信息、本机文件与项目的请求交给 DSH 后台执行，返回纯文本结果。',parameters:{type:'object',properties:{objective:{type:'string',description:'要完成的任务，包含必要的上下文'}},required:['objective']},execution_mode:'async_effect',read_only:false};
   const SLOW={};
   const settingsTimeout=()=>110000;
   const recentResults=new Map();
   // Keyed by objective: identical calls are coalesced, different ones run in
   // parallel (one subagent each) instead of queueing behind each other.
   const inflight=new Map();
   const confirmed=new Set();
   let flushTimer=null;
   const LONG_TASK_MS=100000;
   const COMMENTARY='\u5df2\u7ecf\u5b89\u6392\u4e0b\u53bb\u4e86\uff0c\u5230\u70b9\u6211\u628a\u7ed3\u679c\u544a\u8bc9\u4f60\u3002';
   function sendCommentary(text){
    if(upstream.readyState!==WebSocket.OPEN)return;
    upstream.send(JSON.stringify({action:'session.commentary.append',content:Array.from(String(text)).slice(0,2000).join(''),status:'completed',event_id:'cmt_'+Math.random().toString(36).slice(2)}));
   }
   function deliverToolResult(id,output){
    if(upstream.readyState!==WebSocket.OPEN)return;
    upstream.send(JSON.stringify({action:'conversation.item.create',item:{type:'function_call_output',call_id:id,output:String(output??'').slice(0,2000)}}));
    taskStatus(id,'returning');
   }
   function flushResponseCreate(){
    if(flushTimer)clearTimeout(flushTimer);
    flushTimer=setTimeout(()=>{
     flushTimer=null;
     if(!confirmed.size||upstream.readyState!==WebSocket.OPEN)return;
     const ids=[...confirmed];confirmed.clear();
     upstream.send(JSON.stringify({action:'response.create',response:{call_ids:ids}}));
     for(const id of ids)taskStatus(id,'completed');
    },400);
   }
   const normalize=text=>Array.from(String(text).replace(/\s+/g,'')).join('');
   function handleHostTool(call){
    if(typeof run!=='function')return;
    const id=call.call_id;
    let args={};try{args=JSON.parse(call.arguments||'{}')}catch{}
    const objective=typeof args.objective==='string'&&args.objective.trim()?args.objective:String(call.arguments||'');
    const key=normalize(objective);
    recordHistory('task',objective);
    if(!titles.has(id))titles.set(id,shortTitle(objective));
    const running=inflight.get(key);
    if(running){running.callIds.add(id);taskStatus(id,'running');return;}
    const cached=recentResults.get(key);
    if(cached&&cached.at>Date.now()-120000){deliverToolResult(id,cached.output);flushResponseCreate();return;}
    const controller=new AbortController();
    const entry={callIds:new Set([id]),controller,objective,startedAt:Date.now(),status:'running',output:''};
    taskLog.set(key,entry);
    while(taskLog.size>50)taskLog.delete(taskLog.keys().next().value);
    inflight.set(key,entry);
    taskStatus(id,'running');
    const work=Promise.resolve()
     .then(()=>run({delegationId:id,objective,purpose:'task',context:[],timeoutMs:settingsTimeout()},{signal:controller.signal,reportProgress:()=>false}))
     .catch(error=>'任务执行失败：'+((error&&error.message)||error));
    const deadline=new Promise(resolve=>setTimeout(()=>resolve(SLOW),LONG_TASK_MS));
    entry.promise=Promise.race([work,deadline]).then(async raced=>{
     const ids=[...entry.callIds];
     inflight.delete(key);
     if(raced===SLOW){
      // Long-horizon task (e.g. "remind me in two minutes"): answer the call
      // now, then speak the real result out of band when the work lands.
      if(!controller.signal.aborted)for(const callId of ids)deliverToolResult(callId,COMMENTARY);
      const text=String(await work).slice(0,2000);
      recordHistory('result',text);
      recentResults.set(key,{output:text,at:Date.now()});
      entry.status='done';entry.output=text;entry.endedAt=Date.now();
      if(!controller.signal.aborted)sendCommentary(text);
      return;
     }
     const text=String(raced??'');
     recentResults.set(key,{output:text,at:Date.now()});
     entry.status='done';entry.output=text;entry.endedAt=Date.now();
     if(!controller.signal.aborted)for(const callId of ids)deliverToolResult(callId,text);
    });
   }
   upstream.on('open',()=>upstream.send(JSON.stringify({action:'attach_session',memory_scope:'session',delegation:{type:delegation}})));
   upstream.on('message',(bytes,binary)=>{
    try{
     if(binary){if(browser.readyState===WebSocket.OPEN)browser.send(bytes,{binary:true});return;}
     const raw=JSON.parse(bytes.toString());
     if(raw.action==='input.transcript.done')recordHistory('user',raw.data?.text);
     if(raw.action==='output.transcript.done')recordHistory('assistant',raw.data?.text);
     if(raw.action==='session.delegation.created')recordHistory('task',raw.data?.objective);
     if(raw.action==='response.function_call_arguments.done'&&raw.data&&raw.data.name==='dsh_tasks'){
      const callId=raw.data.call_id;
      deliverToolResult(callId,statusText());
      flushResponseCreate();
      return;
     }
     if(raw.action==='response.function_call_arguments.done'&&raw.data&&raw.data.name==='dsh_task'){
      handleHostTool(raw.data);
      return;
     }
     if(raw.action==='conversation.item.created'&&raw.data&&raw.data.item&&raw.data.item.call_id){
      confirmed.add(raw.data.item.call_id);
      flushResponseCreate();
     }
     if(raw.action==='response.function_call.cancel_requested'&&raw.data){
      for(const entry of inflight.values())entry.controller.abort();
      taskStatus(raw.data.call_id,'cancelled');
      return;
     }
     if(bridge){
      bridge.handle(raw);
      if(raw.action==='session.delegation.created'&&typeof raw.data?.delegation?.id==='string'){
       const id=raw.data.delegation.id;
       if(!titles.has(id))titles.set(id,shortTitle(raw.data.objective));
       taskStatus(id,'queued');
      }
      if(raw.action==='session.delegation.cancelled')taskStatus(raw.data?.delegation_id,'cancelled');
      if(['session.thinking.appended','session.commentary.appended'].includes(raw.action)){
       const receipt=receipts.get(raw.data?.client_event_id);
       if(receipt){receipts.delete(raw.data.client_event_id);taskStatus(receipt.id,receipt.status);}
      }
     }
     const event=filterEvent(raw);if(!event)return;
     if(event.action==='session_attached'){
      attached=true;clearTimeout(attachTimer);
      // Wrapper change: the Host may force its own session policy (instructions
      // and persona) right after attach, before any user audio is accepted.
      if(instructions||persona||typeof run==='function'){
       const session={};if(instructions)session.instructions=instructions;if(persona)session.persona=persona;
       if(typeof run==='function')session.tools=[HOST_TOOL,HOST_STATUS_TOOL];
       upstream.send(JSON.stringify({action:'session.update',session}));
      }
     }
     if(event.action.startsWith('session.delegation.')||event.action.endsWith('.appended'))return;
     if(browser.readyState===WebSocket.OPEN)browser.send(JSON.stringify(event).split(apiKey).join('[redacted]'));
    }catch(error){dbg('dispatch-error',{message:String(error&&error.message||error)});stop();}
   });
   browser.on('message',(bytes,binary)=>{
    try{
     if(!attached||upstream.readyState!==WebSocket.OPEN)throw Error('NOT_ATTACHED');
     if(!binary){
      const event=validateRequest(JSON.parse(bytes.toString()));
      if(!browserActions.has(event.action))throw Error('EVENT_NOT_ALLOWED');
      if(event.action==='session.update'&&event.session&&Array.isArray(event.session.tools)&&typeof run==='function'){
       event.session.tools=[HOST_TOOL,HOST_STATUS_TOOL,...event.session.tools.filter(tool=>tool&&!['dsh_task','dsh_tasks'].includes(tool.name))];
      }
      upstream.send(JSON.stringify(event));
     }
     else upstream.send(bytes,{binary:true});
    }catch(error){dbg('browser-input-error',{message:String(error&&error.message||error)});stop();}
   });
   upstream.on('close',(code,reason)=>{dbg('upstream-close',{code,reason:reason?.toString?.()??String(reason)});});
   upstream.on('error',error=>{dbg('upstream-error',{message:String(error&&error.message||error)});});
   browser.on('close',(code,reason)=>{dbg('browser-close',{code,reason:reason?.toString?.()??String(reason)});});
   for(const ws of [browser,upstream]){ws.on('close',stop);ws.on('error',stop);}
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(bind.port||80),bind.hostname.replace(/[\[\]]/g,''),resolve);});
 const port=server.address().port;authority=`${bind.hostname}:${port}`;
 return {url:`http://${authority}/#${token}`,close(){return closePromise??=(async()=>{closing=true;const record=active;record?.stop();await record?.complete;await new Promise(r=>wss.close(r));await new Promise((r,j)=>server.close(e=>e?j(e):r()));if(cleanupError)throw cleanupError;})();}};
}
