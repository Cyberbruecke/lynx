// String-rewrite construction: a placeholder token replaced by a literal builds the real path.
// Folds .replace(literal, literal) — a regex scraper only sees the pre-replacement string.
fetch("/api/__VER__/users".replace("__VER__", "v2"));
