// Positional (method, path) builder call: the HTTP-verb literal immediately before a "/path"
// argument marks the URL — a generalization of xhr.open(method, url).
function send(cfg, method, path) { return doRequest(cfg, method, path); }
send(config, "POST", "/v1/users");
