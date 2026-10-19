// Collection iterated to inject <script> resources: each chunk name is folded into a CDN URL and assigned to
// a dynamically-created element's .src (a resource-load sink). Only the CDN base is literal.
const cdn = "https://cdn.example.com/dist";
const chunks = ["main", "vendor"];

chunks.forEach(function (name) {
  const s = document.createElement("script");
  s.src = `${cdn}/${name}.min.js`;
  document.body.appendChild(s);
});
