// Path-sensitive cartesian: two independent conditionals (version, endpoint) yield all four path combinations.
const BASE = "https://api.store.com";
const isProduction = true; // In reality, this might be dynamic
const environment = isProduction ? "v3" : "staging";

const category = "electronics";
let endpoint = "";

const userType = "guest";
if (userType === "admin") {
    endpoint = "management/inventory";
} else {
    endpoint = "public/catalog";
}

const finalUrl = `${BASE}/${environment}/${endpoint}/${category}`;

fetch(finalUrl)
  .then(r => r.json())
  .then(console.log);
