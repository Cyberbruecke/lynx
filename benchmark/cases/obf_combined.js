// COMBINED: base64 host + array-join path + concatenation (each fold contributes one segment)
var host = atob("aHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20=");
var path = ["v1", "users"].join("/");
navigator.sendBeacon(host + "/" + path);
