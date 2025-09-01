import dns from "dns/promises";
import ipaddr from "ipaddr.js";

// Quick host checks without DNS
export function isLocalHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return (
    h === "localhost" ||
    h === "ip6-localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h === "" // defensive
  );
}

export function isPrivateIp(ip) {
  try {
    const addr = ipaddr.parse(ip);
    if (addr.kind() === "ipv6") {
      if (addr.isLoopback() || addr.isLinkLocal() || addr.range() === "uniqueLocal") return true;
      // Treat IPv4-mapped addresses accordingly
      if (addr.isIPv4MappedAddress()) {
        return isPrivateIp(addr.toIPv4Address().toString());
      }
      return false;
    }
    // IPv4
    if (addr.range() === "loopback") return true; // 127.0.0.0/8
    if (addr.range() === "private") return true; // 10/8, 172.16/12, 192.168/16
    if (addr.range() === "linkLocal") return true; // 169.254/16
    if (addr.range() === "reserved") return true; // 0.0.0.0/8 etc
    return false;
  } catch {
    return false;
  }
}

export function isIpLiteral(hostname) {
  try {
    ipaddr.parse(hostname);
    return true;
  } catch {
    return false;
  }
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
    h.endsWith(".lan")
  );
}

// DNS-based check (best-effort) to prevent SSRF to private networks
export async function hostnameResolvesToPrivate(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) return true;
    }
    return false;
  } catch {
    // If DNS fails, be conservative and allow (could be transient)
    return false;
  }
}

export function isHttpProtocol(u) {
  return u.protocol === "http:" || u.protocol === "https:";
}

export function safeParseUrl(str) {
  try {
    return new URL(str);
  } catch {
    return null;
  }
}

export async function preflightIsUrlAllowed(urlStr) {
  const u = safeParseUrl(urlStr);
  if (!u) return { ok: false, reason: "invalid_url" };
  if (!isHttpProtocol(u)) return { ok: false, reason: "unsupported_protocol" };
  if (isLocalHostname(u.hostname)) return { ok: false, reason: "blocked_localhost" };
  if (isIpLiteral(u.hostname) && isPrivateIp(u.hostname)) return { ok: false, reason: "blocked_private_ip" };
  if (await hostnameResolvesToPrivate(u.hostname)) return { ok: false, reason: "blocked_private_resolution" };
  return { ok: true };
}

// Lightweight, synchronous checks suitable for request interception inside Playwright
export function shouldBlockRequestUrl(requestUrl) {
  let u;
  try {
    u = new URL(requestUrl);
  } catch {
    return true; // malformed
  }
  if (!isHttpProtocol(u)) return true;
  const h = u.hostname;
  if (isLocalHostname(h)) return true;
  if (isIpLiteral(h) && isPrivateIp(h)) return true;
  if (isProbablyPrivateHostname(h)) return true;
  return false;
}

