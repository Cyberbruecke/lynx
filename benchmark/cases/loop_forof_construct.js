// for-of over an array of collection names, building each endpoint from a base + the loop variable.
// The full URLs never appear as literals (only the base does), so a regex scraper recovers just the base —
// LyN-X iterates the array and reconstructs every endpoint.
const base = "https://api.example.com/v1";
const collections = ["users", "orders", "products"];

for (const c of collections) {
  fetch(`${base}/${c}`);
}
