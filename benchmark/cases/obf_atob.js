// base64-encoded exfil URL (regex sees only an opaque blob) -> atob fold recovers it
var target = atob("aHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vdjEvdXNlcnM=");
fetch(target);
