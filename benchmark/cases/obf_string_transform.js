// case-obfuscated host -> toLowerCase fold normalizes it before concatenation
var host = "API.EXAMPLE.COM";
fetch("https://" + host.toLowerCase() + "/v1/users");
