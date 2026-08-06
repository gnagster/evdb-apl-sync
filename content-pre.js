// Run at document_start, before jplist initializes. jplist pagination renders
// only `data-items-per-page` (10) items into the DOM, so models on later
// pages don't exist in the DOM at all: the price script can't assign them
// APL prices, and jplist's "Price Low-High" sort can never bring a cheap
// off-page model to the top. Bump the page size so every model is in the DOM
// at once.
//
// jplist reads the page size once at its DOMContentLoaded init and locks it
// in (refresh()/change events won't grow the DOM afterwards), so the patch
// must land BEFORE init. Patch at every pre-init moment: during HTML parsing
// (MutationObserver), at DOMContentLoaded, and via a short interval as a last
// resort.
(() => {
  if (!document.documentElement) return;
  const patch = () => {
    const pag = document.querySelector('[data-jplist-control="pagination"]');
    if (pag) pag.setAttribute('data-items-per-page', '100000');
  };
  const obs = new MutationObserver(() => {
    if (document.querySelector('[data-jplist-control="pagination"]')) {
      patch();
      obs.disconnect();
    }
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => {
    patch();
    obs.disconnect();
  });
  const iv = setInterval(() => {
    if (document.querySelector('[data-jplist-control="pagination"]')) {
      patch();
      obs.disconnect();
      clearInterval(iv);
    }
  }, 200);
  setTimeout(() => clearInterval(iv), 4000);
})();
