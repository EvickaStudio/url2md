import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isLocalHostname,
  isPrivateIp,
  isIpLiteral,
  isProbablyPrivateHostname,
  safeParseUrl,
  isHttpProtocol,
  shouldBlockRequestUrl,
} from "../../src/security.js";

describe("isLocalHostname", () => {
  it("matches localhost variants", () => {
    assert.equal(isLocalHostname("localhost"), true);
    assert.equal(isLocalHostname("ip6-localhost"), true);
    assert.equal(isLocalHostname("foo.localhost"), true);
    assert.equal(isLocalHostname("bar.local"), true);
  });
  it("allows public hostnames", () => {
    assert.equal(isLocalHostname("example.com"), false);
    assert.equal(isLocalHostname("google.com"), false);
  });
  it("blocks empty string", () => {
    assert.equal(isLocalHostname(""), true);
  });
});

describe("isPrivateIp", () => {
  it("blocks loopback", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("::1"), true);
  });
  it("blocks RFC-1918 ranges", () => {
    assert.equal(isPrivateIp("10.0.0.1"), true);
    assert.equal(isPrivateIp("192.168.1.1"), true);
    assert.equal(isPrivateIp("172.16.0.1"), true);
    assert.equal(isPrivateIp("172.31.255.255"), true);
  });
  it("allows public IPs", () => {
    assert.equal(isPrivateIp("8.8.8.8"), false);
    assert.equal(isPrivateIp("1.1.1.1"), false);
  });
  it("returns false for garbage input", () => {
    assert.equal(isPrivateIp("not-an-ip"), false);
  });
});

describe("isIpLiteral", () => {
  it("returns true for valid IPs", () => {
    assert.equal(isIpLiteral("127.0.0.1"), true);
    assert.equal(isIpLiteral("::1"), true);
    assert.equal(isIpLiteral("8.8.8.8"), true);
  });
  it("returns false for hostnames", () => {
    assert.equal(isIpLiteral("example.com"), false);
    assert.equal(isIpLiteral(""), false);
  });
});

describe("isProbablyPrivateHostname", () => {
  it("blocks common internal TLDs", () => {
    assert.equal(isProbablyPrivateHostname("foo.internal"), true);
    assert.equal(isProbablyPrivateHostname("box.home"), true);
    assert.equal(isProbablyPrivateHostname("ns.corp"), true);
    assert.equal(isProbablyPrivateHostname("svc.lan"), true);
  });
  it("blocks inline private CIDR patterns", () => {
    assert.equal(isProbablyPrivateHostname("10.1.2.3"), true);
    assert.equal(isProbablyPrivateHostname("192.168.0.1"), true);
    assert.equal(isProbablyPrivateHostname("172.20.0.1"), true);
  });
  it("allows public hostnames", () => {
    assert.equal(isProbablyPrivateHostname("example.com"), false);
    assert.equal(isProbablyPrivateHostname("api.github.com"), false);
  });
});

describe("safeParseUrl", () => {
  it("parses valid URLs", () => {
    const u = safeParseUrl("https://example.com/path?q=1");
    assert.ok(u instanceof URL);
    assert.equal(u.hostname, "example.com");
  });
  it("returns null for invalid input", () => {
    assert.equal(safeParseUrl("not a url"), null);
    assert.equal(safeParseUrl(""), null);
  });
});

describe("isHttpProtocol", () => {
  it("accepts http and https", () => {
    assert.equal(isHttpProtocol(new URL("http://x.com")), true);
    assert.equal(isHttpProtocol(new URL("https://x.com")), true);
  });
  it("rejects other schemes", () => {
    assert.equal(isHttpProtocol(new URL("ftp://x.com")), false);
    assert.equal(isHttpProtocol(new URL("file:///etc/passwd")), false);
  });
});

describe("shouldBlockRequestUrl", () => {
  it("blocks localhost", () => {
    assert.equal(shouldBlockRequestUrl("http://localhost/"), true);
  });
  it("blocks private IPs", () => {
    assert.equal(shouldBlockRequestUrl("http://192.168.1.1/"), true);
    assert.equal(shouldBlockRequestUrl("http://10.0.0.1/secret"), true);
  });
  it("blocks internal TLDs", () => {
    assert.equal(shouldBlockRequestUrl("http://server.internal/api"), true);
  });
  it("allows public URLs", () => {
    assert.equal(shouldBlockRequestUrl("https://example.com/page"), false);
  });
  it("blocks malformed URLs", () => {
    assert.equal(shouldBlockRequestUrl("not-a-url"), true);
  });
  it("blocks non-http schemes", () => {
    assert.equal(shouldBlockRequestUrl("ftp://example.com/file"), true);
  });
});
