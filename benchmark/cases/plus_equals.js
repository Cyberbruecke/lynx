// compound-assignment (+=) accumulation — a distinct resolution path from binary-+ concat,
// and unlike relwarc case 7 the accumulated value is fully resolvable.
var u = "https://api.example.com";
u += "/v1";
u += "/users";
fetch(u);
