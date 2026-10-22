export async function checkSite(url,marker,fallback) {
  const r=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(r.status===403 && r.headers.get('cf-mitigated')==='challenge') {
    // Cloudflare challenges GitHub's data-centre IPs; browser checks verify the public route.
    if(fallback) {
      const origin=await fetch(fallback,{signal:AbortSignal.timeout(10000)});
      if(!origin.ok || !(await origin.text()).includes(marker))throw Error('Ursprung des bisherigen Rechners ist nicht verfügbar.');
    }
    return {challenge:true};
  }
  if(!r.ok || !(await r.text()).includes(marker))throw Error('Unerwartete Website-Antwort: HTTP '+r.status);
  return {challenge:false};
}
