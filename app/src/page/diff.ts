// What changed between two descriptions of a page, line by line (indentation ignored), for action receipts.

export function diffLines(prev: string[], next: string[]): {added: string[]; removed: string[]} {
  const a = prev.map(l => l.trim()), b = next.map(l => l.trim());
  // Longest common subsequence table; descriptions are a few hundred lines, so O(n·m) is fine.
  const dp: number[][] = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const added: string[] = [], removed: string[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]); else added.push(b[j++]);
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  return {added, removed};
}

export function renderDiff(d: {added: string[]; removed: string[]}, max = 30): string {
  const count = d.added.length + d.removed.length;
  if (count === 0) return '';
  if (count > max) return `страница сильно изменилась (${count} строк), сделайте snapshot`;
  return [...d.added.map(l => `+ ${l}`), ...d.removed.map(l => `- ${l}`)].join('\n');
}
