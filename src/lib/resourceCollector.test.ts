import { describe, expect, test } from "bun:test";

import { createResourceCollector, createResourceDiagnosticTail, ResourceCollectorFailureError, RESOURCE_FAILURE_STDERR_MAX_BYTES } from "./resourceCollector";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("resource collector", () => {
  test("a fresh fence waits for an observation that started after the request", async () => {
    let now = 0;
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => (++calls === 1 ? first.promise : second.promise),
      now: () => now,
    });

    const stale = collector.observe(0, 1_000);
    await Promise.resolve();
    const requestFence = collector.fence();
    const fresh = collector.observe(requestFence, 1_000);
    first.resolve("first");
    await expect(stale).resolves.toMatchObject({ observation: { generation: 1, value: "first" } });
    now = 1;
    second.resolve("second");
    await expect(fresh).resolves.toMatchObject({ observation: { generation: 2, value: "second" } });
  });

  test("a bounded wait returns the immutable previous observation with a timeout diagnostic", async () => {
    const first = deferred<string>();
    const never = deferred<string>();
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => (++calls === 1 ? first.promise : never.promise),
    });

    const initial = collector.observe(0, 1_000);
    first.resolve("prior");
    await initial;
    const timedOut = await collector.observe(collector.fence(), 1);

    expect(timedOut).toMatchObject({
      observation: { generation: 1, value: "prior" },
      failure: { reason: "timeout", diagnostic: { cause: "observation-timeout" } },
    });
    expect(Object.isFrozen(timedOut)).toBeTrue();
  });

  test("a zero-wait observation reports a typed busy result", async () => {
    const pending = deferred<string>();
    const collector = createResourceCollector({
      collectorId: "busy-collector",
      collect: async () => pending.promise,
    });

    const result = await collector.observe(0, 0);
    expect(result).toMatchObject({
      observation: null,
      collectorId: "busy-collector",
      failure: { reason: "collector-busy", diagnostic: { cause: "collection-active" } },
    });
    pending.resolve("complete");
  });

  test("failure diagnostics preserve bounded redacted nested causes and stderr", async () => {
    const nested = new Error("PASSWORD=inner-secret");
    const outer = new Error("Bearer outer-secret", { cause: nested });
    const collector = createResourceCollector({
      collectorId: "failed-collector",
      collect: async () => {
        throw new ResourceCollectorFailureError(
          "collector-crash",
          "collector-error",
          "resource collection failed",
          {
            cause: outer,
            stderr: `${"safe ".repeat(RESOURCE_FAILURE_STDERR_MAX_BYTES)}\nAPI_TOKEN=stderr-secret`,
          },
        );
      },
    });

    const result = await collector.observe(0, 1_000);
    expect(result.failure).toMatchObject({
      reason: "collector-crash",
      diagnostic: {
        cause: "collector-error",
        causes: ["Bearer <redacted>", "PASSWORD=<redacted>"],
      },
    });
    const stderr = result.failure?.diagnostic.stderr ?? "";
    expect(Buffer.byteLength(stderr)).toBe(RESOURCE_FAILURE_STDERR_MAX_BYTES);
    expect(stderr).toContain("API_TOKEN=<redacted>");
    expect(stderr).not.toContain("stderr-secret");
  });

  test("streaming diagnostics fully redact a bare Bearer credential", () => {
    const tail = createResourceDiagnosticTail();
    tail.append("Bearer bare-secret-sentinel\nsafe suffix");

    expect(tail.value()).toContain("Bearer <redacted>");
    expect(tail.value()).toContain("safe suffix");
    expect(tail.value()).not.toContain("bare-secret-sentinel");
  });

  test("streaming diagnostics retain keyed Authorization Bearer state across chunks", () => {
    const tail = createResourceDiagnosticTail();
    tail.append("Authorization: Bear");
    tail.append("er keyed-secret-sentinel\nsafe suffix");

    expect(tail.value()).toContain("Authorization=<redacted>");
    expect(tail.value()).toContain("safe suffix");
    expect(tail.value()).not.toContain("keyed-secret-sentinel");
  });

  test("streaming diagnostics fully redact a single-quoted Bearer credential", () => {
    const tail = createResourceDiagnosticTail();
    const fragments = ["SINGLELEAK", "QUOTEDLEAK", "SECRETLEAK"];
    tail.append(`Authorization: Bearer '${fragments.join(" ")}'\nsafe suffix`);

    expect(tail.value()).toContain("Authorization=<redacted>");
    expect(tail.value()).toContain("safe suffix");
    for (const fragment of fragments) expect(tail.value()).not.toContain(fragment);
  });

  test("streaming diagnostics fully redact a double-quoted Bearer credential", () => {
    const tail = createResourceDiagnosticTail();
    const fragments = ["DOUBLELEAK", "QUOTEDLEAK", "SECRETLEAK"];
    tail.append(`Authorization: Bearer "${fragments.join(" ")}"\nsafe suffix`);

    expect(tail.value()).toContain("Authorization=<redacted>");
    expect(tail.value()).toContain("safe suffix");
    for (const fragment of fragments) expect(tail.value()).not.toContain(fragment);
  });

  test("streaming diagnostics bound long Bearer credentials while retaining a safe suffix", async () => {
    const tail = createResourceDiagnosticTail();
    const credential = "LONGLEAK!".repeat(1_000);
    tail.append("discarded-safe-prefix\n".repeat(300));
    tail.append("Authorization: Bearer ");
    for (let offset = 0; offset < credential.length; offset += 137) {
      tail.append(credential.slice(offset, offset + 137));
    }
    tail.append("\nsafe diagnostic suffix 😀");
    const streamed = tail.value();
    const collector = createResourceCollector({
      collectorId: "long-bearer",
      collect: async () => {
        throw new ResourceCollectorFailureError(
          "collector-crash",
          "collector-error",
          "resource collection failed",
          { stderr: streamed },
        );
      },
    });
    const result = await collector.observe(0, 1_000);
    const diagnostic = result.failure?.diagnostic.stderr ?? "";

    expect(Buffer.byteLength(streamed)).toBeLessThanOrEqual((RESOURCE_FAILURE_STDERR_MAX_BYTES * 2) + (256 * 4));
    expect(diagnostic).toContain("Authorization=<redacted>");
    expect(diagnostic).toContain("safe diagnostic suffix 😀");
    expect(diagnostic).not.toContain("LONGLEAK");
    expect(diagnostic).not.toContain("\uFFFD");
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
  });

  test("streaming diagnostics retain Authorization Bearer state through prefix eviction", () => {
    const tail = createResourceDiagnosticTail();
    tail.append(`Authorization:${" ".repeat(600)}`);
    tail.append(`Bearer${" ".repeat(600)}`);
    tail.append("EVICTIONLEAK!\nsafe suffix");
    const diagnostic = tail.value();

    expect(diagnostic).toContain("<redacted>");
    expect(diagnostic).toContain("safe suffix");
    expect(diagnostic).not.toContain("EVICTIONLEAK");
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual((RESOURCE_FAILURE_STDERR_MAX_BYTES * 2) + (256 * 4));
  });

  test("streaming diagnostics retain an evicted Authorization key before its delimiter", () => {
    const tail = createResourceDiagnosticTail();
    tail.append(`Authorization${" ".repeat(600)}`);
    tail.append(`:${" ".repeat(600)}`);
    tail.append("Bearer DELIMITERLEAK!\nsafe suffix");
    const diagnostic = tail.value();

    expect(diagnostic).toContain("<redacted>");
    expect(diagnostic).toContain("safe suffix");
    expect(diagnostic).not.toContain("DELIMITERLEAK");
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual((RESOURCE_FAILURE_STDERR_MAX_BYTES * 2) + (256 * 4));
  });

  test("streaming Bearer redaction covers every split position and quote form", () => {
    const safeSuffix = "safe suffix é € 😀";
    const cases = [
      { name: "bare", input: `prefix é€😀\nBearer BARELEAK-FRAGMENT\n${safeSuffix}`, fragments: ["BARELEAK", "FRAGMENT"] },
      { name: "keyed", input: `prefix é€😀\nAuthorization: Bearer KEYEDLEAK-FRAGMENT\n${safeSuffix}`, fragments: ["KEYEDLEAK", "FRAGMENT"] },
      { name: "single-quoted credential", input: `prefix é€😀\nAuthorization: Bearer 'SINGLELEAK FRAGMENT'\n${safeSuffix}`, fragments: ["SINGLELEAK", "FRAGMENT"] },
      { name: "double-quoted credential", input: `prefix é€😀\nAuthorization: Bearer "DOUBLELEAK FRAGMENT"\n${safeSuffix}`, fragments: ["DOUBLELEAK", "FRAGMENT"] },
      { name: "single-quoted value", input: `prefix é€😀\nAuthorization: 'Bearer OUTERSINGLELEAK FRAGMENT'\n${safeSuffix}`, fragments: ["OUTERSINGLELEAK", "FRAGMENT"] },
      { name: "double-quoted value", input: `prefix é€😀\nAuthorization: "Bearer OUTERDOUBLELEAK FRAGMENT"\n${safeSuffix}`, fragments: ["OUTERDOUBLELEAK", "FRAGMENT"] },
    ];

    for (const fixture of cases) {
      for (let split = 0; split <= fixture.input.length; split += 1) {
        const tail = createResourceDiagnosticTail();
        tail.append(fixture.input.slice(0, split));
        tail.append(fixture.input.slice(split));
        const diagnostic = tail.value();
        const label = `${fixture.name} split ${split}`;

        expect(diagnostic.includes("<redacted>"), label).toBeTrue();
        expect(diagnostic.includes(safeSuffix), label).toBeTrue();
        expect(diagnostic.includes("\uFFFD"), label).toBeFalse();
        expect(Buffer.byteLength(diagnostic), label).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
        for (const fragment of fixture.fragments) {
          expect(diagnostic.includes(fragment), `${label} fragment ${fragment}`).toBeFalse();
        }
      }
    }
  });

  test("streaming Authorization redaction covers every scheme, field boundary, split, and terminal flush", async () => {
    const safeLine = "X-Safe-After: preserved é € 😀";
    const cases = [
      {
        name: "Basic",
        input: `Authorization: Basic BASICLEAK==\r\n${safeLine}`,
        fragments: ["BASICLEAK"],
      },
      {
        name: "Digest",
        input: `Authorization: Digest username="DIGESTUSER", realm="DIGESTREALM", response="DIGESTRESPONSE"\n${safeLine}`,
        fragments: ["DIGESTUSER", "DIGESTREALM", "DIGESTRESPONSE"],
      },
      {
        name: "Negotiate",
        input: `Authorization: Negotiate NEGOTIATELEAK FIRSTTAIL SECONDTAIL\r${safeLine}`,
        fragments: ["NEGOTIATELEAK", "FIRSTTAIL", "SECONDTAIL"],
      },
      {
        name: "custom",
        input: `Authorization=Custom scheme=CUSTOMLEAK quoted="CUSTOMTAIL VALUE"\n${safeLine}`,
        fragments: ["CUSTOMLEAK", "CUSTOMTAIL"],
      },
      {
        name: "embedded key",
        input: `proxy.AUTHORIZATION_trace: Custom EMBEDDEDLEAK tail=EMBEDDEDTAIL\n${safeLine}`,
        fragments: ["EMBEDDEDLEAK", "EMBEDDEDTAIL"],
      },
      {
        name: "quoted field",
        input: `Authorization: "Digest username=QUOTEDLEAK response=QUOTEDTAIL" trailing=FIELDTAIL\n${safeLine}`,
        fragments: ["QUOTEDLEAK", "QUOTEDTAIL", "FIELDTAIL"],
      },
    ];

    for (const fixture of cases) {
      for (let split = 0; split <= fixture.input.length; split += 1) {
        const tail = createResourceDiagnosticTail();
        tail.append(fixture.input.slice(0, split));
        tail.append(fixture.input.slice(split));
        const diagnostic = tail.value();
        const label = `${fixture.name} split ${split}`;

        expect(diagnostic.includes("<redacted>"), label).toBeTrue();
        expect(diagnostic.includes(safeLine), label).toBeTrue();
        expect(diagnostic.includes("\uFFFD"), label).toBeFalse();
        expect(Buffer.byteLength(diagnostic), label).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
        for (const fragment of fixture.fragments) {
          expect(diagnostic.includes(fragment), `${label} fragment ${fragment}`).toBeFalse();
        }
      }

      const fieldEnd = fixture.input.search(/[\r\n]/);
      const terminalInput = fieldEnd < 0 ? fixture.input : fixture.input.slice(0, fieldEnd);
      for (let split = 0; split <= terminalInput.length; split += 1) {
        const terminal = createResourceDiagnosticTail();
        terminal.append(terminalInput.slice(0, split));
        terminal.append(terminalInput.slice(split));
        const diagnostic = terminal.value();
        const label = `${fixture.name} terminal split ${split}`;

        expect(diagnostic.includes("<redacted>"), label).toBeTrue();
        for (const fragment of fixture.fragments) {
          expect(diagnostic.includes(fragment), `${label} fragment ${fragment}`).toBeFalse();
        }
      }
    }

    const longCredential = "LONG-AUTHORIZATION-LEAK ".repeat(1_000);
    const streamed = createResourceDiagnosticTail();
    streamed.append("discarded safe prefix\n".repeat(300));
    streamed.append("Authorization: Custom ");
    for (let offset = 0; offset < longCredential.length; offset += 73) {
      streamed.append(longCredential.slice(offset, offset + 73));
    }
    streamed.append(`\r\n${safeLine}`);
    const collector = createResourceCollector({
      collectorId: "long-authorization",
      collect: async () => {
        throw new ResourceCollectorFailureError(
          "collector-crash",
          "collector-error",
          "resource collection failed",
          { stderr: streamed.value() },
        );
      },
    });
    const result = await collector.observe(0, 1_000);
    const diagnostic = result.failure?.diagnostic.stderr ?? "";

    expect(diagnostic).toContain("Authorization=<redacted>");
    expect(diagnostic).toContain(safeLine);
    expect(diagnostic).not.toContain("LONG-AUTHORIZATION-LEAK");
    expect(diagnostic).not.toContain("\uFFFD");
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
  });

  test("static and streaming diagnostics redact quoted Authorization keys and quoted Bearer values", async () => {
    const cases = [
      {
        name: "quoted JSON Basic",
        input: '{"Authorization":"Basic QUOTED_JSON_BASIC_LEAK","safe":"SAFE_JSON_FIELD"}',
        safe: "SAFE_JSON_FIELD",
        secrets: ["QUOTED_JSON_BASIC_LEAK"],
      },
      {
        name: "single-quoted Digest",
        input: "{'Authorization':'Digest username=\"DIGEST_USER_LEAK\" response=\"DIGEST_RESPONSE_LEAK\"','safe':'SAFE_DIGEST_FIELD'}",
        safe: "SAFE_DIGEST_FIELD",
        secrets: ["DIGEST_USER_LEAK", "DIGEST_RESPONSE_LEAK"],
      },
      {
        name: "quoted JSON Negotiate",
        input: '{"Authorization":"Negotiate NEGOTIATE_LEAK FIRST_TAIL SECOND_TAIL","safe":"SAFE_NEGOTIATE_FIELD"}',
        safe: "SAFE_NEGOTIATE_FIELD",
        secrets: ["NEGOTIATE_LEAK", "FIRST_TAIL", "SECOND_TAIL"],
      },
      {
        name: "quoted JSON custom scheme",
        input: '{"Authorization":"Custom scheme=CUSTOM_LEAK quoted=\\\"CUSTOM_TAIL VALUE\\\"","safe":"SAFE_CUSTOM_FIELD"}',
        safe: "SAFE_CUSTOM_FIELD",
        secrets: ["CUSTOM_LEAK", "CUSTOM_TAIL"],
      },
      {
        name: "double-quoted Bearer value",
        input: 'Bearer "PART_A_LEAK PART_B_LEAK"\r\nX-Safe-After: SAFE_BEARER_FIELD',
        safe: "SAFE_BEARER_FIELD",
        secrets: ["PART_A_LEAK", "PART_B_LEAK"],
      },
      {
        name: "single-quoted Bearer value",
        input: "Bearer 'SINGLE_PART_A_LEAK SINGLE_PART_B_LEAK'\nX-Safe-After: SAFE_SINGLE_BEARER_FIELD",
        safe: "SAFE_SINGLE_BEARER_FIELD",
        secrets: ["SINGLE_PART_A_LEAK", "SINGLE_PART_B_LEAK"],
      },
    ];

    for (const fixture of cases) {
      for (let split = 0; split <= fixture.input.length; split += 1) {
        const tail = createResourceDiagnosticTail();
        tail.append(fixture.input.slice(0, split));
        tail.append(fixture.input.slice(split));
        const streamed = tail.value();
        const label = `${fixture.name} split ${split}`;

        expect(streamed.includes("<redacted>"), label).toBeTrue();
        expect(streamed.includes(fixture.safe), label).toBeTrue();
        expect(streamed.includes("\uFFFD"), label).toBeFalse();
        expect(Buffer.byteLength(streamed), label).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
        for (const secret of fixture.secrets) {
          expect(streamed.includes(secret), `${label} secret ${secret}`).toBeFalse();
        }
      }

      const collector = createResourceCollector({
        collectorId: `quoted-static-${fixture.name}`,
        collect: async () => {
          throw new ResourceCollectorFailureError(
            "collector-crash",
            "collector-error",
            "resource collection failed",
            { cause: new Error(fixture.input), stderr: fixture.input },
          );
        },
      });
      const result = await collector.observe(0, 1_000);
      const cause = result.failure?.diagnostic.causes[0] ?? "";
      const stderr = result.failure?.diagnostic.stderr ?? "";

      expect(cause.includes(fixture.safe), `${fixture.name} static cause safe field`).toBeTrue();
      expect(stderr.includes(fixture.safe), `${fixture.name} static stderr safe field`).toBeTrue();
      for (const secret of fixture.secrets) {
        expect(cause.includes(secret), `${fixture.name} static cause secret ${secret}`).toBeFalse();
        expect(stderr.includes(secret), `${fixture.name} static stderr secret ${secret}`).toBeFalse();
      }
    }

    const longSecret = "LONG_QUOTED_BEARER_LEAK ".repeat(1_000);
    const longTail = createResourceDiagnosticTail();
    longTail.append('Bearer "');
    for (let offset = 0; offset < longSecret.length; offset += 61) {
      longTail.append(longSecret.slice(offset, offset + 61));
    }
    longTail.append('"\r\nX-Safe-After: LONG_SAFE_SUFFIX 😀');
    const longDiagnostic = longTail.value();

    expect(longDiagnostic).toContain("Bearer <redacted>");
    expect(longDiagnostic).toContain("LONG_SAFE_SUFFIX 😀");
    expect(longDiagnostic).not.toContain("LONG_QUOTED_BEARER_LEAK");
    expect(longDiagnostic).not.toContain("\uFFFD");
    expect(Buffer.byteLength(longDiagnostic)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
  });

  test("stringified Authorization diagnostics redact every scheme and multi-token Bearer value", async () => {
    const stringifiedAuthorization = (authorization: string, safe: string) => JSON.stringify(JSON.stringify({ Authorization: authorization, safe }));
    const cases = [
      {
        name: "Basic",
        input: stringifiedAuthorization("Basic BASIC_STRINGIFIED_LEAK==", "SAFE_BASIC_é€😀"),
        safe: "SAFE_BASIC_é€😀",
        secrets: ["BASIC_STRINGIFIED_LEAK"],
      },
      {
        name: "Digest",
        input: stringifiedAuthorization('Digest username="DIGEST_USER_LEAK", response="DIGEST_RESPONSE_LEAK"', "SAFE_DIGEST_é€😀"),
        safe: "SAFE_DIGEST_é€😀",
        secrets: ["DIGEST_USER_LEAK", "DIGEST_RESPONSE_LEAK"],
      },
      {
        name: "Negotiate",
        input: stringifiedAuthorization("Negotiate NEGOTIATE_LEAK FIRST_TAIL SECOND_TAIL", "SAFE_NEGOTIATE_é€😀"),
        safe: "SAFE_NEGOTIATE_é€😀",
        secrets: ["NEGOTIATE_LEAK", "FIRST_TAIL", "SECOND_TAIL"],
      },
      {
        name: "custom",
        input: stringifiedAuthorization("Custom scheme=CUSTOM_LEAK tail=CUSTOM_TAIL", "SAFE_CUSTOM_é€😀"),
        safe: "SAFE_CUSTOM_é€😀",
        secrets: ["CUSTOM_LEAK", "CUSTOM_TAIL"],
      },
      {
        name: "Bearer",
        input: stringifiedAuthorization('Bearer "BEARER_FIRST_LEAK BEARER_SECOND_LEAK"', "SAFE_BEARER_é€😀"),
        safe: "SAFE_BEARER_é€😀",
        secrets: ["BEARER_FIRST_LEAK", "BEARER_SECOND_LEAK"],
      },
      {
        name: "bare multi-token Bearer",
        input: "Bearer BARE_FIRST_LEAK BARE_SECOND_LEAK\nSAFE_BARE_é€😀",
        safe: "SAFE_BARE_é€😀",
        secrets: ["BARE_FIRST_LEAK", "BARE_SECOND_LEAK"],
      },
    ];

    for (const fixture of cases) {
      for (let split = 0; split <= fixture.input.length; split += 1) {
        const tail = createResourceDiagnosticTail();
        tail.append(fixture.input.slice(0, split));
        tail.append(fixture.input.slice(split));
        const diagnostic = tail.value();
        const label = `${fixture.name} split ${split}`;

        expect(diagnostic.includes("<redacted>"), label).toBeTrue();
        expect(diagnostic.includes(fixture.safe), `${label} safe`).toBeTrue();
        expect(diagnostic.includes("\uFFFD"), `${label} UTF-8`).toBeFalse();
        expect(Buffer.byteLength(diagnostic), `${label} size`).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
        for (const secret of fixture.secrets) {
          expect(diagnostic.includes(secret), `${label} secret ${secret}`).toBeFalse();
        }
      }

      const collector = createResourceCollector({
        collectorId: `stringified-static-${fixture.name}`,
        collect: async () => {
          throw new ResourceCollectorFailureError(
            "collector-crash",
            "collector-error",
            "resource collection failed",
            { cause: new Error(fixture.input), stderr: fixture.input },
          );
        },
      });
      const result = await collector.observe(0, 1_000);
      const cause = result.failure?.diagnostic.causes[0] ?? "";
      const stderr = result.failure?.diagnostic.stderr ?? "";

      expect(cause.includes(fixture.safe), `${fixture.name} static cause safe`).toBeTrue();
      expect(stderr.includes(fixture.safe), `${fixture.name} static stderr safe`).toBeTrue();
      for (const secret of fixture.secrets) {
        expect(cause.includes(secret), `${fixture.name} static cause ${secret}`).toBeFalse();
        expect(stderr.includes(secret), `${fixture.name} static stderr ${secret}`).toBeFalse();
      }
    }

    const evicted = createResourceDiagnosticTail();
    evicted.append("old safe prefix é€😀\n".repeat(300));
    const longSecret = "LONG_STRINGIFIED_BEARER_LEAK ".repeat(1_000);
    const serialized = stringifiedAuthorization(`Bearer "${longSecret}"`, "SAFE_EVICTION_é€😀");
    const secretAt = serialized.indexOf(longSecret);
    evicted.append(serialized.slice(0, secretAt));
    for (let offset = 0; offset < longSecret.length; offset += 67) {
      evicted.append(longSecret.slice(offset, offset + 67));
    }
    evicted.append(serialized.slice(secretAt + longSecret.length));
    const diagnostic = evicted.value();

    expect(diagnostic).toContain("<redacted>");
    expect(diagnostic).toContain("SAFE_EVICTION_é€😀");
    expect(diagnostic).not.toContain("LONG_STRINGIFIED_BEARER_LEAK");
    expect(diagnostic).not.toContain("\uFFFD");
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);

    const keyEvicted = createResourceDiagnosticTail();
    const encoded = stringifiedAuthorization("Basic EVICTED_KEY_LEAK==", "SAFE_KEY_EVICTION_é€😀");
    const delimiterAt = encoded.indexOf(":");
    keyEvicted.append(encoded.slice(0, delimiterAt) + " ".repeat(5_000));
    keyEvicted.append(encoded.slice(delimiterAt));
    const keyEvictedDiagnostic = keyEvicted.value();

    expect(keyEvictedDiagnostic).toContain("<redacted>");
    expect(keyEvictedDiagnostic).toContain("SAFE_KEY_EVICTION_é€😀");
    expect(keyEvictedDiagnostic).not.toContain("EVICTED_KEY_LEAK");
    expect(keyEvictedDiagnostic).not.toContain("\uFFFD");
    expect(Buffer.byteLength(keyEvictedDiagnostic)).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
  });

  test("stderr tail truncation preserves every UTF-8 boundary", async () => {
    for (const character of ["é", "€", "😀"]) {
      const width = Buffer.byteLength(character);
      for (let offset = 0; offset < width; offset += 1) {
        const marker = `\ntail-${width}-${offset}`;
        const suffixBytes = RESOURCE_FAILURE_STDERR_MAX_BYTES - width + offset;
        const fillerBytes = suffixBytes - Buffer.byteLength(marker);
        const filler = "s ".repeat(Math.floor(fillerBytes / 2)) + "s".repeat(fillerBytes % 2);
        const stderrInput = `prefix${character}${filler}${marker}`;
        const collector = createResourceCollector({
          collectorId: `utf8-${width}-${offset}`,
          collect: async () => {
            throw new ResourceCollectorFailureError(
              "collector-crash",
              "collector-error",
              "resource collection failed",
              { stderr: stderrInput },
            );
          },
        });

        const result = await collector.observe(0, 1_000);
        const stderr = result.failure?.diagnostic.stderr ?? "";
        expect(Buffer.byteLength(stderr), `width ${width}, offset ${offset}`).toBeLessThanOrEqual(RESOURCE_FAILURE_STDERR_MAX_BYTES);
        expect(stderr.includes("\uFFFD"), `width ${width}, offset ${offset}`).toBeFalse();
        expect(stderr.endsWith(marker), `width ${width}, offset ${offset}`).toBeTrue();
      }
    }
  });

  test("concurrent callers coalesce only when their fences are already satisfied", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => (++calls === 1 ? first.promise : second.promise),
    });

    const one = collector.observe(0, 1_000);
    const two = collector.observe(0, 1_000);
    await Promise.resolve();
    expect(calls).toBe(1);
    first.resolve("one");
    await Promise.all([one, two]);

    const fence = collector.fence();
    const three = collector.observe(fence, 1_000);
    const four = collector.observe(fence, 1_000);
    await Promise.resolve();
    expect(calls).toBe(2);
    second.resolve("two");
    await expect(Promise.all([three, four])).resolves.toEqual([
      expect.objectContaining({ observation: expect.objectContaining({ generation: 2, value: "two" }) }),
      expect.objectContaining({ observation: expect.objectContaining({ generation: 2, value: "two" }) }),
    ]);
  });

  test("a durable completed observation serves before any new collection starts", async () => {
    let calls = 0;
    const collector = createResourceCollector({
      collectorId: "test-collector",
      collect: async () => {
        calls += 1;
        return "new";
      },
      initial: Object.freeze({ generation: 7, startedAt: 1, completedAt: 2, collectorId: "prior", value: "durable" }),
    });

    expect(collector.latest()).toMatchObject({ generation: 7, value: "durable" });
    expect(calls).toBe(0);
  });
});
