// Loop-built path plus URLSearchParams: segments are appended in a for-loop and the query is assembled
// from an object, then folded into one concrete URL.
const BASE = "https://api.store.com";
const version = "v3";

// 1. Data that will drive our URL construction
const pathSegments = ["inventory", "electronics", "laptops"];
const filters = {
  brand: "apple",
  min_ram: "16gb",
  in_stock: true,
  sort: "price_asc"
};

// 2. Build the Path using a loop (or .join)
// We start with the base and version, then loop through segments
let pathString = `${BASE}/${version}`;

for (const segment of pathSegments) {
  pathString += `/${segment}`;
} 
// Result so far: https://api.store.com/v3/inventory/electronics/laptops

// 3. Build the Query Parameters using a loop
const queryParams = new URLSearchParams();

Object.entries(filters).forEach(([key, value]) => {
  // We can even add logic inside the loop to skip empty values
  if (value !== null && value !== undefined) {
    queryParams.append(key, value);
  }
});

// 4. Combine everything
const finalUrl = `${pathString}?${queryParams.toString()}`;

console.log("Generated URL:", finalUrl);

// 5. Execute
fetch(finalUrl)
  .then(res => res.json())
  .then(console.log)
  .catch(err => console.error("Request failed", err));
