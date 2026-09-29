import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReportUrl,
  postBuildReport,
  postManifestWithEnvironmentFallback,
  reportsBuildWithoutCredential,
} from "../src/client.js";
import { computeManifestChecksum } from "../src/checksum.js";
import type { Config } from "../src/types.js";
import { PatchstackError } from "../src/types.js";

const packages = [
  { name: "react", version: "19.0.0" },
  { name: "@tanstack/react-start", version: "1.2.3" },
];

function config(overrides: Partial<Config> = {}): Config {
  return {
    siteUuid: "55b1e661-469d-4d67-b592-f90378c3ef81",
    endpoint: "https://api.example.com/monitor/pulse/manifest",
    timeoutMs: 30_000,
    widget: true,
    environment: "production",
    ...overrides,
  } as Config;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reportsBuildWithoutCredential", () => {
  it("is a production build of a registered site with no key", () => {
    expect(reportsBuildWithoutCredential(config())).toBe(true);
  });

  it("is not a build that has a key, a preview, a laptop build, or a site not yet registered", () => {
    expect(
      reportsBuildWithoutCredential(config({ pulseAuth: "secret-12" })),
    ).toBe(false);
    expect(
      reportsBuildWithoutCredential(config({ environment: "sandbox" })),
    ).toBe(false);
    expect(
      reportsBuildWithoutCredential(config({ environment: "local" })),
    ).toBe(false);
    expect(reportsBuildWithoutCredential(config({ siteUuid: null }))).toBe(
      false,
    );
  });
});

describe("buildReportUrl", () => {
  it("sits beside the manifest endpoint", () => {
    expect(
      buildReportUrl("https://api.example.com/monitor/pulse/manifest", "u-1"),
    ).toBe("https://api.example.com/monitor/pulse/build/u-1");
  });

  it("falls back to the default path for an endpoint that is not a manifest path", () => {
    expect(buildReportUrl("https://api.example.com/?x=1#y", "u 1")).toBe(
      "https://api.example.com/monitor/pulse/build/u%201",
    );
  });
});

describe("postManifestWithEnvironmentFallback without a key", () => {
  it("names the build by checksum once the manifest is refused", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(401, { error: "A bearer token is required." }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { result: "recorded" }));
    vi.stubGlobal("fetch", fetchMock);

    const { response, environmentUsed } =
      await postManifestWithEnvironmentFallback(
        config(),
        { packages } as never,
        "no-pages",
      );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.example.com/monitor/pulse/manifest/55b1e661-469d-4d67-b592-f90378c3ef81",
    );
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(
      "https://api.example.com/monitor/pulse/build/55b1e661-469d-4d67-b592-f90378c3ef81",
    );
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      checksum: computeManifestChecksum(packages),
      environment: "production",
      marker: "no-pages",
    });
    expect(response).toMatchObject({ stored: false, reason: "build-reported" });
    expect(environmentUsed).toBe("production");
  });

  it("leaves a manifest the server accepted without a key alone, as a host token push is", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, {
          uuid: "x",
          stored: true,
          manifest_id: 1,
          checksum: "c",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await postManifestWithEnvironmentFallback(config(), {
      packages,
    } as never).catch(() => null);

    expect(
      fetchMock.mock.calls
        .map((call) => call[0] as string)
        .some((u) => u.includes("/build/")),
    ).toBe(false);
  });

  it("says the key is needed when the build is not the one last scanned", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(422, {
            result: "unknown-build",
            error: "Not the build last scanned. Set PATCHSTACK_API_KEY.",
          }),
        ),
    );

    await expect(
      postBuildReport(config(), "abcdefabcdef"),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Not the build last scanned. Set PATCHSTACK_API_KEY.",
    });
  });

  it("says the key is needed when the server has no build report yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
    );

    const refusal = await postBuildReport(config(), "abcdefabcdef").catch(
      (err: unknown) => err,
    );

    expect(refusal).toBeInstanceOf(PatchstackError);
    expect((refusal as PatchstackError).message).toMatch(/PATCHSTACK_API_KEY/);
  });

  it("still sends the full manifest when the build has a key", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith("/token")
          ? jsonResponse(200, {
              access_token: "t",
              expires_in: 3600,
              token_type: "Bearer",
            })
          : jsonResponse(200, {
              uuid: "x",
              stored: true,
              manifest_id: 1,
              checksum: "c",
            }),
      );
    vi.stubGlobal("fetch", fetchMock);

    // Only where the build was sent matters here; the reply is not a manifest response.
    await postManifestWithEnvironmentFallback(
      config({ pulseAuth: "secret-12" }),
      { packages } as never,
    ).catch(() => null);

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls.some((u) => u.includes("/monitor/pulse/build/"))).toBe(false);
    expect(urls.some((u) => u.includes("/monitor/pulse/manifest/"))).toBe(true);
  });
});
