// Numeric-argument string-slice fold: the URL is carved out of a padded decoy with substring()/slice().
var blob = "PADhttps://api.example.com/v1/users";
fetch(blob.substring(3));
