// Path-sensitive protocol: an if/else picks http:// vs https://, so both scheme variants are emitted.
var protocol = null;
const domain = 'jsonplaceholder.typicode.com';
var secure = true;
if (secure) {
    protocol = 'https://';
} else {
    protocol = 'http://';
}
const BASE_URL = protocol + domain;

const ENDPOINT = '/users/1';

// Concatenating the two constants using backticks
fetch(BASE_URL + ENDPOINT)
  .then(res => res.json())
  .then(data => console.log(data));
