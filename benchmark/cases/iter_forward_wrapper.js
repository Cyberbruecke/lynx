// Iteration forward (forEach -> wrapper): a literal list of root-relative routes is iterated and each
// element is passed to a user function that performs the load (a custom sink wrapper); the URL never appears
// at a modeled sink directly. Forwarding the iteration element into the wrapper resolves each route against
// the wrapper's host. Regex greps the routes but resolves them against the page origin, missing the CDN host.
function loadScript(u) { const el = document.createElement("script"); el.src = "https://cdn.example.com" + u; document.head.appendChild(el); }
["/a/main.js", "/a/vendor.js", "/a/runtime.js"].filter(Boolean).forEach(u => loadScript(u));
