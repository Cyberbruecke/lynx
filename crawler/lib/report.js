"use strict";
// Shared reporting helpers for the score tables (bench.js + compare.js).
const DISPLAY = { grep: "grep", linkfinder: "LinkFinder", jsluice: "JSluice", relwarc: "relwarc", lynx: "LyN-X" };
const disp = (t) => DISPLAY[t] || t;

// LaTeX-escape a table cell: the six specials plus ~, ^, and square brackets.
const texEsc = (s) => String(s).replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}")
  .replace(/\^/g, "\\textasciicircum{}").replace(/\[/g, "{[}").replace(/\]/g, "{]}");

module.exports = { DISPLAY, disp, texEsc };
