// Text-level checks for workflow files (no YAML parser is a dependency).

/** The nearest line above `n` that is indented less than line `n` (its YAML parent), or null. */
export function parentOf(ls: string[], n: number): { text: string; indent: number } | null {
  const indent = ls[n]!.search(/\S/);
  for (let k = n - 1; k >= 0; k--) {
    if (ls[k]!.trim() === "" || ls[k]!.trim().startsWith("#")) continue;
    const i = ls[k]!.search(/\S/);
    if (i < indent) return { text: ls[k]!.trim(), indent: i };
  }
  return null;
}
export const code = (l: string) => !l.trim().startsWith("#");

/** Problems with where secrets appear: only as a plain value under a step's own `env:` (8 spaces; a job-level `env:` would reach every step). */
export function secretProblems(ls: string[]): string[] {
  const problems: string[] = [];
  ls.forEach((l, n) => {
    if (!code(l)) return;
    if (/^\s*env:/.test(l) && l.search(/\S/) < 8) problems.push(`line ${n + 1}: env: above step level`);
    if (!/secrets\b/i.test(l)) return;
    if (!/^ {10}[A-Z_]+: \$\{\{ secrets\.[A-Z_]+ \}\}$/.test(l)) return void problems.push(`line ${n + 1}: a secret outside a step env value: ${l.trim()}`);
    const parent = parentOf(ls, n);
    if (parent?.text !== "env:" || parent.indent !== 8) problems.push(`line ${n + 1}: not under a step's env:`);
  });
  return problems;
}

/** Problems with `${{ }}` expressions: allowed only as values under `env:` or `with:`, never inside a `run:` script (injection). */
export function injectionProblems(ls: string[]): string[] {
  const problems: string[] = [];
  ls.forEach((l, n) => {
    if (!code(l) || !l.includes("${{")) return;
    const parent = parentOf(ls, n);
    if (!/^\s+[A-Za-z_-]+: .*\}\}$/.test(l) || (parent?.text !== "env:" && parent?.text !== "with:")) problems.push(`line ${n + 1}: expression outside env/with: ${l.trim()}`);
  });
  return problems;
}

export const yaml = (s: string) => s.split("\n");
