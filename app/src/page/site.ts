// A site as rules name it: the host without www, or '' for pages that are not http(s).
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}
