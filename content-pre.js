// Run at document_start, before jplist initializes. jplist pagination renders
// only `data-items-per-page` (10) items into the DOM, so models on later
// pages don't exist in the DOM at all: the price script can't assign them
// APL prices, and jplist's "Price Low-High" sort can never bring a cheap
// off-page model to the top. Bump the page size so every model is in the DOM
// at once. MutationObserver fires during HTML parsing, well before
// jplist's DOMContentLoaded init.
(() => {
  if (!document.documentElement) return;
  const obs = new MutationObserver(() => {
    const pag = document.querySelector('[data-jplist-control="pagination"]');
    if (!pag) return;
    pag.setAttribute('data-items-per-page', '100000');
    obs.disconnect();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
