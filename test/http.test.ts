import { afterEach, describe, expect, it, vi } from "vitest";
import { asStageFailure, ScrapeError } from "../src/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe task-stage failures", () => {
  it("records a stage and error class without logging exception messages or URLs", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = asStageFailure(new TypeError("fetch failed for https://cdn.example/image.jpg?token=secret"), "IMAGE_FETCH_FAILED");

    expect(failure).toBeInstanceOf(ScrapeError);
    expect(failure.code).toBe("IMAGE_FETCH_FAILED");
    expect(failure.retryable).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("IMAGE_FETCH_FAILED");
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("https://");
    expect(logged).not.toContain("secret");
  });

  it("preserves known scraper errors and their retry policy", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = new ScrapeError("IMAGE_HTTP_403", false);
    expect(asStageFailure(original, "IMAGE_FETCH_FAILED")).toBe(original);
    expect(original.code).toBe("IMAGE_HTTP_403");
    expect(original.retryable).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("uses a safe error class for non-Error exceptions", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = asStageFailure("sensitive value", "IMAGE_FETCH_FAILED");
    expect(failure.code).toBe("IMAGE_FETCH_FAILED");
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive value");
    expect(JSON.stringify(log.mock.calls)).toContain("UnknownError");
  });
});
