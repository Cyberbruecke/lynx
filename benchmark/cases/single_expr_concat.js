// Single-expression string concatenation of literals. JSluice's AST folds it to the full URL;
// a pure-regex extractor (LinkFinder) only captures the first literal chunk (the host), so this
// case separates AST single-expression resolution from regex.
fetch("https://api.example.com" + "/v1/users");
