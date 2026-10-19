// XMLHttpRequest.open(method, url): the URL is the 2nd positional arg, gated by an HTTP-method 1st arg.
const xhr = new XMLHttpRequest();
xhr.open("GET", "/v1/users");
