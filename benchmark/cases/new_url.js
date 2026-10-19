// new URL(relative, base): the endpoint is resolved by the URL constructor joining a relative path to
// a base, not by `+`/template concat — isolates URL-constructor resolution.
var base = "https://api.example.com/v1/";
fetch(new URL("users", base));
