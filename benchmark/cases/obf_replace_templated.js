// Templated .replace(): a {token} placeholder replaced by a runtime value — the SDK path-param
// shape (e.g. algolia "/1/indexes/{indexName}".replace("{indexName}", idx)). Yields a templated route.
fetch("/1/indexes/{indexName}/objects".replace("{indexName}", indexName));
