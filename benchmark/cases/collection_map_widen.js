// Collection widening (map): the endpoint is selected at runtime by indexing a route map with an opaque key
// (here a function call). The whole route set is reachable, so a sound static extractor emits all of them,
// concatenated onto the host, rather than a bare placeholder. Regex greps the root-relative route literals
// but resolves them against the page origin, missing the SDK's real api host.
const api = { list: "/v1/items", detail: "/v1/items/detail", search: "/v1/search" };
const host = "https://api.example.com";
const k = route();                     // opaque runtime key
fetch(host + api[k]);
