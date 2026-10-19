// Request-config object: { method, url } — the URL is a PROPERTY, gated on a sibling HTTP method
// (which excludes SPA router configs { path, component }). Shape used by axios(config) and SDKs.
request({ method: "POST", url: "/v1/users", body: {} });
