// Collection build (imperative map): the route map starts empty and is populated by property assignments
// across statements (including a computed-dynamic key), not as one literal. The flow-merged object model
// gathers those assignments so an opaque index widens over the whole set.
const host = "https://api.example.com";
const api = {};
api.list = "/v1/items";
api["detail"] = "/v1/items/detail";
api[dyn()] = "/v1/search";             // computed-dynamic write
const k = route();
fetch(host + api[k]);
