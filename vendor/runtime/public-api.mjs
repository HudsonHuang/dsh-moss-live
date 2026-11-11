import fields from './public-fields.json' with {type:'json'};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const only=(v,names)=>object(v)&&Object.keys(v).every(k=>names.split(' ').includes(k));
const select=(v,names)=>{
 const out={};for(const k of names.split(' ')){
  if(!object(v)||!Object.hasOwn(v,k))continue;const x=v[k];
  if(['response','item','error','delegation'].includes(k)){if(object(x)||(['error','delegation'].includes(k)&&typeof x==='string'))out[k]=x;}
  else if(['context','output'].includes(k)){if(Array.isArray(x))out[k]=x;}
  else if(k==='tools')out[k]=Array.isArray(x)?x.filter(y=>typeof y==='string'):[];
  else if(['offset_ms','timeout_ms','output_index','client_timestamp','server_recv_timestamp'].includes(k)){if(Number.isFinite(x))out[k]=x;}
  else if(typeof x==='string'||x===null)out[k]=x;
 }return out;
};
const string=(v,k,required=false)=>!Object.hasOwn(v,k)?!required:typeof v[k]==='string'&&(!required||!!v[k].trim());
const list=v=>Array.isArray(v)&&v.every(x=>typeof x==='string');
export function validateRequest(m){
 if(!object(m))throw Error('INVALID_PUBLIC_REQUEST');
 const action=m.action??m.type,allowed=fields.inputs[action];
 let valid=typeof action==='string'&&allowed!==undefined&&only(m,`action type ${allowed}`)&&(!m.type||m.type===action);
 switch(action){
 case 'attach_session':valid&&=(!m.session_id||typeof m.session_id==='string')&&(!m.memory_scope||['session','user'].includes(m.memory_scope))&&['none','client'].includes(typeof m.delegation==='object'?m.delegation?.type:m.delegation??'none');break;
 case 'session.update':{
  const s=m.session;valid&&=only(s,'persona instructions tools');if(!valid)break;
  if(Object.hasOwn(s,'instructions'))valid&&=typeof s.instructions==='string'&&Array.from(s.instructions).length<=16000;
  if(s.persona!==undefined&&s.persona!==null)valid&&=only(s.persona,'name aliases prompt')&&string(s.persona,'name')&&string(s.persona,'prompt')&&(s.persona.aliases===undefined||list(s.persona.aliases));
  if(s.tools!==undefined)valid&&=Array.isArray(s.tools)&&s.tools.length<=32&&s.tools.every(t=>only(t,'type name description parameters')&&t.type==='function'&&string(t,'name',true)&&string(t,'description')&&(t.parameters===undefined||object(t.parameters)));
  break;
 }
 case 'response.create':valid&&=only(m.response,'call_ids')&&list(m.response.call_ids);break;
 case 'conversation.item.create':valid&&=only(m.item,'id type call_id output')&&m.item.type==='function_call_output'&&Object.hasOwn(m.item,'output')&&string(m.item,'call_id',true)&&string(m.item,'id');break;
 case 'mic_state':case 'video.state':valid&&=typeof m.enabled==='boolean'&&(action==='mic_state'||m.source===undefined||['camera','screen'].includes(m.source));break;
 case 'video.stream_focus':valid&&=['auto','camera','screen'].includes(m.source);break;
 case 'media.mode':valid&&=m.binary_protocol==='tagged-v1';break;
 default:
  if(action?.startsWith('playback.'))valid&&=allowed.split(' ').filter(k=>!['played_audio_ms','reason'].includes(k)).every(k=>string(m,k,true));
  if(action?.endsWith('.append'))valid&&=string(m,'content',true)&&Array.from(m.content).length<=2000&&string(m,'delegation_id',true)&&['in_progress','completed','failed'].includes(m.status??'in_progress');
 }
 if(m.played_audio_ms!==undefined)valid&&=Number.isFinite(m.played_audio_ms)&&m.played_audio_ms>=0;
 if(!valid)throw Error('INVALID_PUBLIC_REQUEST');
 const out={...m,action};delete out.type;return out;
}
export function filterEvent(m){
 const name=m?.action,names=fields.outputs[name];if(names===undefined)return null;
 const data=object(m.data)?m.data:m,out=select(data,names);
 if(name==='error')out.error={...select(data.error,'code client_event_id'),message:'request could not be accepted'};
 if(name==='session.updated'&&out.error)out.error='invalid session configuration';
 if(name==='response.done')out.response={...select(out.response,'id status'),output:(Array.isArray(out.response?.output)?out.response.output:[]).map(x=>select(x,'type call_id item_id name arguments output_index status'))};
 if(name==='conversation.item.created')out.item=select(out.item,'id type call_id');
 if(name==='session.delegation.created'){
  out.delegation=select(out.delegation,'id type target');out.context=(out.context??[]).map(x=>select(x,'role content'));
 }
 if(Object.hasOwn(data,'type'))out.type=name;
 return {action:name,data:out};
}
