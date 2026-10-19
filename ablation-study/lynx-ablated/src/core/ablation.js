"use strict";
// Capability-ablation gates for the ablation study (see ablation-study/README.md).
//
// The set of DISABLED capability ids is read ONCE from the LYNX_ABLATE env var (comma-separated). When it
// is empty — the production default — `ablated()` is always false, so every gate is a no-op and this
// instrumented copy behaves byte-for-byte like stock lyn-x.js. Each id names exactly one URL-recovery
// capability; when present, that capability's dispatch point degrades to a placeholder / passthrough
// instead of resolving, so a URL that can ONLY be built via that capability disappears from the output.
//
// The 13 ids are the study's capability buckets. Kept here (not scattered) so the harness and the gates
// agree on one list. Gates for a given id live at every code path that implements it — for several
// capabilities that means BOTH the static resolver (resolve.js) and the runtime interpreter (runtime.js).
//
//   template      backtick `...${}` template-literal assembly
//   concat        string concatenation: binary `+` and String.prototype.concat
//   member        member/property resolution: object-literal deep props, computed access, config
//                 objects, and member-assignment (webpack public path `l.p = "/static/"`)
//   interproc     interprocedural function-return tracing (a URL returned by a called function)
//   iteration     loop / collection reconstruction: for/for-of/while unroll, .map/.filter/.reduce,
//                 and forEach-style callback element binding
//   array_join    array assembly: [..].join(sep) and split().reverse().join() char-array (re)assembly
//   atob          base64 decoding (atob / window.atob)
//   fromCharCode  String.fromCharCode char-code decoding
//   str_transform string method folding: toLowerCase/toUpperCase/trim*/slice/substring/substr/normalize
//   str_replace   String.replace / replaceAll literal-pattern substitution
//   new_url       new URL(relative, base) resolution
//   query_params  query-string assembly: new URLSearchParams(obj) and entries.toString()
//   promise       Promise .then/.catch/.finally callback-return tracing
//   collection_widen  bounded widening of computed collection access: arr[i] / obj[k] with an opaque
//                     index/key -> union of ALL statically-known entries (each is a possible endpoint)
//   collection_build  PROTOTYPE (own-file recall study): flow-merged object model — an obj[k]/obj.k map
//                     built imperatively (obj[k]=v assignment sequences), via Object.assign, or via object
//                     spread {...a} is made enumerable so collection_widen can union its entries. Extends
//                     resolveMemberFromObjectMap beyond the single initializer literal.
//   iter_forward      PROTOTYPE (own-file recall study): forward the element of a literal-array iteration
//                     (arr.forEach/.map, through a trailing .filter(Boolean)) into interprocedural call
//                     arguments, so `[lit,lit].filter(Boolean).forEach(u => wrapper(u))` resolves each lit.

const IDS = [
    "template", "concat", "member", "interproc", "iteration", "array_join",
    "atob", "fromCharCode", "str_transform", "str_replace", "new_url",
    "query_params", "promise", "collection_widen",
    "collection_build", "iter_forward",   // prototypes for the own-file-bucket conversion study
];

// Fail loud on a typo'd id so a harness bug can't silently run a no-op "ablation" that looks like the
// capability wasn't needed. Only checked when something was requested.
function validate(set) {
    for (const id of set) {
        if (!IDS.includes(id)) {
            throw new Error(`[ablation] unknown LYNX_ABLATE id "${id}"; known ids: ${IDS.join(", ")}`);
        }
    }
    return set;
}

// The disabled set is normally read ONCE from LYNX_ABLATE at import (production default = empty). The
// ablation harness, however, runs baseline + one-capability-off IN A SINGLE PROCESS (to pay Node's
// cold-start/module-load only once per file instead of once per config), so it needs to re-point the set
// between analyses via setDisabled(). `let` + a live-read `ablated()` make that switch instantaneous; each
// analysis builds a fresh LyNX/AST so nothing carries over between configs.
let _disabled = validate(new Set(
    String(process.env.LYNX_ABLATE || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
));

function setDisabled(ids) {
    _disabled = validate(new Set((Array.isArray(ids) ? ids : String(ids || "").split(",")).map((s) => String(s).trim()).filter(Boolean)));
    return _disabled;
}

function ablated(id) {
    return _disabled.has(id);
}

module.exports = { ablated, setDisabled, IDS, get disabled() { return [..._disabled]; } };
