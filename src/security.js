import dns from "dns/promises";
import ipaddr from "ipaddr.js";

export function isLocalHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return (
    h === "localhost" ||
    h === "ip6-localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h === ""
  );
}

export function isPrivateIp(ip) {
  try {
    const addr = ipaddr.parse(ip);
    if (addr.kind() === "ipv6") {
      if (addr.isLoopback() || addr.isLinkLocal() || addr.range() === "uniqueLocal") return true;
      if (addr.isIPv4MappedAddress()) return isPrivateIp(addr.toIPv4Address().toString());
      return false;
    }
    const r = addr.range();
    return ["loopback", "private", "linkLocal", "reserved", "unspecified"].includes(r);
  } catch {
    return false;
  }
}

export function isIpLiteral(hostname) {
  try { ipaddr.parse(hostname); return true; } catch { return false; }
}

export function isProbablyPrivateHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return (
    isLocalHostname(h) ||
    h === "0.0.0.0" ||
    h === "::" ||
    h.endsWith(".internal") ||
    h.endsWith(".intranet") ||
    h.endsWith(".home") ||
    h.endsWith(".lan") ||
    h.endsWith(".corp") ||
    h.endsWith(".test") ||
    h.endsWith(".example") ||
    h.endsWith(".invalid") ||
    /^10\.\d+\.\d+\.\d+$/.test(h) ||
    /^192\.168\.\d+\.\d+$/.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)
  );
}

export async function hostnameResolvesToPrivate(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.some((r) => isPrivateIp(r.address));
  } catch {
    return true; // fail-closed on DNS rebinding
  }
}

export function isHttpProtocol(u) {
  return u.protocol === "http:" || u.protocol === "https:";
}

export function safeParseUrl(str) {
  try { return new URL(str); } catch { return null; }
}

export async function preflightIsUrlAllowed(urlStr) {
  const u = safeParseUrl(urlStr);
  if (!u) return { ok: false, reason: "invalid_url" };
  if (!isHttpProtocol(u)) return { ok: false, reason: "unsupported_protocol" };
  if (isLocalHostname(u.hostname)) return { ok: false, reason: "blocked_localhost" };
  if (isIpLiteral(u.hostname) && isPrivateIp(u.hostname)) return { ok: false, reason: "blocked_private_ip" };
  if (isProbablyPrivateHostname(u.hostname)) return { ok: false, reason: "blocked_private_hostname" };
  if (await hostnameResolvesToPrivate(u.hostname)) return { ok: false, reason: "blocked_private_resolution" };
  return { ok: true };
}

export function shouldBlockRequestUrl(requestUrl) {
  let u;
  try { u = new URL(requestUrl); } catch { return true; }
  if (!isHttpProtocol(u)) return true;
  const h = u.hostname;
  if (isLocalHostname(h)) return true;
  if (isIpLiteral(h) && isPrivateIp(h)) return true;
  if (isProbablyPrivateHostname(h)) return true;
  return false;
}
