// Computed-member sink: the call target window[m] resolves to fetch through the variable m.
const method = "fetch";
window[method]("http://malicious.com");
