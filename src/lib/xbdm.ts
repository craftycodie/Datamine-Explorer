// The address of an Xbox 360 as a live source: "xbdm://<host>:730", the port of its debug monitor.
// Plain string work, so the UI can use it without the worker's parsers.
export const XBDM_SCHEME = "xbdm://";
const XBDM_PORT = 730;

export function isXbdmUrl(url: string): boolean {
  return url.toLowerCase().startsWith(XBDM_SCHEME);
}

// "xbdm://192.168.0.48:730" for whatever the user typed: an address, with or without the scheme or port.
export function xbdmUrl(typed: string): string {
  const host = typed.trim().replace(/^xbdm:\/\//i, "").replace(/\/+$/, "");
  return `${XBDM_SCHEME}${host.includes(":") ? host : `${host}:${XBDM_PORT}`}`;
}
