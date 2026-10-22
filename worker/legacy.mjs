// Keep the existing Pages calculator and its deployments reachable at its new address.
export default {
  async fetch(request) {
    if(!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
    const url=new URL(request.url);
    return fetch('https://ev-kostenrechner.pages.dev'+url.pathname+url.search,{method:request.method,headers:{Accept:request.headers.get('Accept')||'*/*'}});
  }
};
