import {authenticate,snapshot,agent,applyCorrection,fault} from './agent.mjs';

const response=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if(!['/api/chat','/api/vehicle-check','/api/vehicle-correction'].includes(url.pathname)) return response({error:'Nicht gefunden.'},404);
      if(request.method!=='POST') return response({error:'POST erforderlich.'},405);
      const origin=request.headers.get('Origin');
      if(origin && origin!==url.origin) throw fault('Anfragen von fremden Webseiten sind nicht erlaubt.',403);
      if(!request.headers.get('Content-Type')?.startsWith('application/json')) throw fault('JSON erforderlich.');
      if(Number(request.headers.get('Content-Length'))>128000) throw fault('Anfrage zu groß.',413);
      const token=await authenticate(request,env);
      const reader=request.body.getReader(),chunks=[];let bytes=0;
      for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>128000){await reader.cancel();throw fault('Anfrage zu groß.',413);}chunks.push(value);}
      const all=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
      const body=JSON.parse(new TextDecoder().decode(all));
      if(!body || typeof body!=='object' || Array.isArray(body)) throw fault('Ungültige Anfrage.');
      if(url.pathname!=='/api/chat' && !/^\d+$/.test(body.vehicleId)) throw fault('Ungültige EVDB-ID.');
      if(url.pathname==='/api/chat' && (!Array.isArray(body.messages) || !body.messages.length || body.messages.length>40 || body.messages.some(m=>!['user','assistant'].includes(m.role) || typeof m.content!=='string' || m.content.length>12000))) throw fault('Ungültiger Chatverlauf.');
      if(!env.DEEPSEEK_API_KEY) throw fault('DeepSeek ist noch nicht eingerichtet.',503);
      const s=await snapshot(token);
      const controller=new AbortController();request.signal.addEventListener('abort',()=>controller.abort(),{once:true});
      if(request.signal.aborted)controller.abort();
      if(url.pathname==='/api/vehicle-correction') return response(await applyCorrection(token,s,body,controller.signal));
      const encoder=new TextEncoder();
      const stream=new ReadableStream({
        start(output) {
          const timer=setTimeout(()=>controller.abort(),180000);
          const emit=(type,value)=>{if(!controller.signal.aborted) output.enqueue(encoder.encode(JSON.stringify({type,...value})+'\n'));};
          (async()=>{
            try {await agent(env,s,{...body,mode:url.pathname==='/api/vehicle-check'?'correction':'chat'},emit,controller.signal);}
            catch(e) {if(!controller.signal.aborted) emit('error',{message:e.message});else {try {output.enqueue(encoder.encode(JSON.stringify({type:'error',message:'Die Anfrage wurde abgebrochen oder hat zu lange gedauert.'})+'\n'));}catch{}}}
            finally {clearTimeout(timer);try{output.close();}catch{}}
          })();
        },
        cancel(){controller.abort();}
      });
      return new Response(stream,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    } catch(e) {
      return response({error:e instanceof SyntaxError?'Ungültiges JSON.':e.message||'Anfrage fehlgeschlagen.'},e.status||500);
    }
  }
};
