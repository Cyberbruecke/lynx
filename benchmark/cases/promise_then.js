// Promise callback-return tracing: a .then() callback returns the URL, and the resolved chain feeds a
// sink — recovery requires following the value out of the promise chain. Isolates .then/.catch/.finally.
var p = Promise.resolve().then(function () {
  return "https://api.example.com/v1/users";
});
fetch(p);
