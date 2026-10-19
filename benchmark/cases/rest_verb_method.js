// REST-client dispatch: a custom client's .post("/path") is a URL sink even though the receiver
// isn't a known HTTP library (axios/$/http). Regex/AST baselines don't model this method dispatch.
const client = makeClient({ baseURL: "https://api.example.com" });
client.post("/v1/users");
