// URL assembled from an array of fragments via .join() (variable-bound array)
var parts = ["https://api.example.com", "v1", "users"];
fetch(parts.join("/"));
