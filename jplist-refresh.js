// Page-world helper: content scripts can't see window.jplist, and the page's
// CSP blocks inline <script> injection. Loaded via chrome.runtime.getURL (see
// triggerRefresh in content.js), which the page CSP allows.
window.jplist && window.jplist.refresh();
