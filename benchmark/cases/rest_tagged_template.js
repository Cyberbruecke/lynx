// Tagged-template path builder (Stainless-style `path` tag encodes params): resolve the underlying
// template, treating the tag as identity, so the parameterized route is reconstructed.
client.get(path`/v1/users/${userId}/orders`);
