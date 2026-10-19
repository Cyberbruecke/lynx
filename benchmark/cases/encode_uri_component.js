// Query construction via encodeURIComponent() — passthrough of the encoded value; the endpoint
// path and query key are recovered with the value templated.
fetch("https://api.example.com/search?q=" + encodeURIComponent(term));
