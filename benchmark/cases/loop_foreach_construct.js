// Array.forEach with an arrow callback: the element parameter drives URL construction. LyN-X binds the
// callback parameter to the array's elements and reconstructs each concrete endpoint.
const API = "https://api.example.com";
const versions = ["v1", "v2"];

versions.forEach(v => fetch(API + "/" + v + "/status"));
