// Collection widening (list): the concrete chunk is chosen at runtime by indexing a static list, and the
// full URL is publicPath + entry, so no complete URL is ever a literal. Every entry is a loadable endpoint,
// so a sound static extractor should emit the whole (bounded) set — not a bare {VAR:i} placeholder. This is
// the webpack lazy-chunk idiom; regex greps the bare filenames but can't reassemble host+prefix+entry.
const chunks = ["main.9Us7.js", "vendor.B0Y0.js", "runtime.CvJI.js"];
const publicPath = "https://cdn.example.com/assets/";
const i = pickChunk();                 // opaque runtime index
const s = document.createElement("script");
s.src = publicPath + chunks[i];
document.head.appendChild(s);
