"use strict";
// Spec -> endpoint templates. Supports OpenAPI 3 (servers/paths, local $ref, server-variable defaults) and
// Google API Discovery docs (baseUrl + nested resources[].methods[].path). Output: [{method, path, url}]
// where `url` is the full templated endpoint (server/base + path); path params kept as {name} (the matcher
// normalizes them). Path host may stay templated (e.g. {region}) if the spec gives no default.

const HTTP = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function resolveRef(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  return ref.slice(2).split("/").reduce(
    (o, k) => (o == null ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), doc);
}
function deref(doc, obj, seen = new Set()) {
  if (obj && obj.$ref && !seen.has(obj.$ref)) {
    seen.add(obj.$ref);
    const t = resolveRef(doc, obj.$ref);
    return t ? deref(doc, t, seen) : obj;
  }
  return obj;
}

// OpenAPI server object -> URL, substituting variable defaults so the host is concrete when possible.
function serverUrl(server) {
  if (!server || !server.url) return null;
  const vars = server.variables || {};
  return server.url.replace(/\{([^}]+)\}/g, (m, name) =>
    (vars[name] && vars[name].default != null) ? vars[name].default : m);
}

function joinUrl(base, p) {
  const path = String(p);
  if (!base) return path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;            // path is already absolute
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

function endpointsFromOpenApi(doc, { base } = {}) {
  const out = [];
  const topServer = serverUrl((doc.servers || [])[0]) || base || "";
  for (const [rawPath, rawItem] of Object.entries(doc.paths || {})) {
    const item = deref(doc, rawItem);
    if (!item) continue;
    const itemServer = serverUrl((item.servers || [])[0]);
    for (const method of HTTP) {
      if (!item[method]) continue;
      const op = deref(doc, item[method]);
      const b = serverUrl((op.servers || [])[0]) || itemServer || topServer;
      out.push({ method: method.toUpperCase(), path: rawPath, url: joinUrl(b, rawPath) });
    }
  }
  return out;
}

// Swagger 2.0: host + basePath + schemes + paths (no `servers`).
function endpointsFromSwagger2(doc, { base } = {}) {
  const scheme = (doc.schemes && doc.schemes[0]) || "https";
  const server = doc.host ? `${scheme}://${doc.host}${doc.basePath || ""}` : (base || doc.basePath || "");
  const out = [];
  for (const [rawPath, rawItem] of Object.entries(doc.paths || {})) {
    const item = deref(doc, rawItem);
    if (!item) continue;
    for (const method of HTTP) {
      if (!item[method]) continue;
      out.push({ method: method.toUpperCase(), path: rawPath, url: joinUrl(server, rawPath) });
    }
  }
  return out;
}

function endpointsFromDiscovery(doc) {
  const out = [];
  const base = doc.baseUrl ||
    ((doc.rootUrl || "").replace(/\/+$/, "") + "/" + (doc.servicePath || "").replace(/^\/+/, ""));
  const walk = (res) => {
    if (!res) return;
    for (const m of Object.values(res.methods || {}))
      if (m.path) out.push({ method: (m.httpMethod || "GET").toUpperCase(), path: m.path, url: joinUrl(base, m.path) });
    for (const child of Object.values(res.resources || {})) walk(child);
  };
  walk(doc);
  return out;
}

function detectFormat(doc) {
  if (typeof doc.swagger === "string" && doc.swagger.startsWith("2")) return "swagger2";
  if (doc.openapi) return "openapi3";
  if (doc.discoveryVersion || doc.baseUrl || doc.rootUrl) return "discovery";
  return "openapi3";
}

function dedup(raw) {
  const seen = new Set(), out = [];
  for (const e of raw) { const k = e.method + " " + e.url; if (!seen.has(k)) { seen.add(k); out.push(e); } }
  return out;
}

// Dispatch a single doc + dedup by METHOD+url. format: openapi3 | swagger2 | discovery (auto if omitted).
function endpoints(doc, { format, base } = {}) {
  const fmt = (format && format !== "openapi3") ? format : detectFormat(doc);   // trust an explicit non-default, else sniff
  const raw = fmt === "discovery" ? endpointsFromDiscovery(doc)
    : fmt === "swagger2" ? endpointsFromSwagger2(doc, { base })
      : endpointsFromOpenApi(doc, { base });
  return dedup(raw);
}

// Merge endpoints across MULTIPLE spec docs (e.g. an SDK whose API is split into several spec files).
function endpointsMerged(docs, opts = {}) {
  return dedup(docs.flatMap((d) => endpoints(d, opts)));
}

module.exports = { endpoints, endpointsMerged, endpointsFromOpenApi, endpointsFromSwagger2, endpointsFromDiscovery, serverUrl, joinUrl, detectFormat };
