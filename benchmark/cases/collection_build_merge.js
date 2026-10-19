// Collection build (map merge): the route map is not a single literal — it is assembled by Object.assign
// from several literal fragments, then indexed by an opaque runtime key. A model that only reads the
// initializer literal sees an empty object; the flow-merged object model unions the assembled entries and
// widens over them. Regex greps the root-relative routes but resolves them against the page origin, missing
// the real api host.
const host = "https://api.example.com";
const api = Object.assign({}, { list: "/v1/items" }, { detail: "/v1/items/detail", search: "/v1/search" });
const k = route();                     // opaque runtime key
fetch(host + api[k]);
