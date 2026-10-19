// Scenario 1: classic IIFE with document alias and script src sink
(function (doc) {
    const script = doc.createElement("script");
    script.src = "https://iife1.example.com/a.js";
    doc.head.appendChild(script);
})(document);

// Scenario 2: IIFE with computed member call (window[method])
(function (win) {
    const method = "fetch";
    win[method]("https://iife2.example.com/api");
})(window);

// Scenario 3: nested IIFE with function passed as argument
(function (base) {
    (function (request) {
        request(base + "/users");
    })(fetch);
})("https://iife3.example.com");

// Scenario 4: IIFE with default parameter value
((w = window) => {
    w.fetch("https://iife4.example.com/default");
})();

// Scenario 5: IIFE with URLSearchParams and toString propagation
(function (f) {
    const params = new URLSearchParams({ q: "alpha", page: "1" });
    f("https://iife5.example.com/search?" + params.toString());
})(fetch);

// Scenario 6: IIFE through member alias assignment and invocation
(function (obj) {
    const call = obj.fetch;
    call("https://iife6.example.com/member-alias");
})(window);
