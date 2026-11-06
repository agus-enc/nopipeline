// Code block languages under the names Notion keeps them by.

/**
 * Notion's code block languages, as its API names them. The live probe (recorded in
 * test/fixtures/notion/code-languages.json) confirmed bash, c, c++, css, diff, docker, go, html, java, javascript,
 * json, markdown, plain text, powershell, python, rust, shell, sql, toml, typescript, xml and yaml; the others are
 * from Notion's documentation.
 */
const KNOWN = new Set([
  "abap", "abc", "agda", "arduino", "ascii art", "assembly", "bash", "basic", "bnf", "c", "c#", "c++", "clojure",
  "coffeescript", "coq", "css", "dart", "dhall", "diff", "docker", "ebnf", "elixir", "elm", "erlang", "f#", "flow",
  "fortran", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "hcl", "html", "idris", "java", "javascript",
  "json", "julia", "kotlin", "latex", "less", "lisp", "livescript", "llvm ir", "lua", "makefile", "markdown",
  "markup", "matlab", "mathematica", "mermaid", "nix", "notion formula", "objective-c", "ocaml", "pascal", "perl",
  "php", "plain text", "powershell", "prolog", "protobuf", "purescript", "python", "r", "racket", "reason", "ruby",
  "rust", "sass", "scala", "scheme", "scss", "shell", "smalltalk", "solidity", "sql", "swift", "toml", "typescript",
  "vb.net", "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml", "java/c/c++/c#",
]);

/** Other names Notion takes for a language (all confirmed by the probe). */
const ALIASES: Record<string, string> = {
  js: "javascript",
  py: "python",
  sh: "bash",
  yml: "yaml",
  ts: "typescript",
  text: "plain text",
  txt: "plain text",
  plaintext: "plain text",
  cpp: "c++",
  dockerfile: "docker",
  md: "markdown",
};

/**
 * The language Notion keeps a code block under for the info string it was written with: the name in lower case,
 * an alias as the language it names, and anything else (no language, `zsh`, `Example config file`) as javascript,
 * Notion's default.
 */
export function notionLanguage(info: string): string {
  const name = info.trim().toLowerCase();
  const language = ALIASES[name] ?? name;
  return KNOWN.has(language) ? language : "javascript";
}
