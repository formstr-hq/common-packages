// blossom http client

export class BlossomError extends Error {
  isCorsError: boolean;
  status?: number;
  constructor(message: string, opts?: { isCorsError?: boolean; status?: number }) {
    super(message);
    this.name = "BlossomError";
    this.isCorsError = opts?.isCorsError ?? false;
    this.status = opts?.status;
  }
}

export class BlossomClient {
  constructor(private baseUrl: string) {
    if (this.baseUrl.endsWith("/")) this.baseUrl = this.baseUrl.slice(0, -1);
  }

  async upload(blob: Uint8Array, authHeader: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/upload`, {
        method: "PUT",
        headers: { Authorization: authHeader, "Content-Type": "application/octet-stream" },
        body: blob as any,
      });
    } catch (e) {
      if (e instanceof TypeError) {
        throw new BlossomError(
          `Network error reaching ${this.baseUrl}, possible CORS or unreachable host`,
          { isCorsError: true },
        );
      }
      throw e;
    }
    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText, { status: res.status });
    }
    return res.text();
  }

  async download(sha256: string, authHeader?: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${sha256}`, {
        headers: authHeader ? { Authorization: authHeader } : {},
      });
    } catch (e) {
      if (e instanceof TypeError) {
        throw new BlossomError(`Network error reaching ${this.baseUrl}`, { isCorsError: true });
      }
      throw e;
    }
    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText, { status: res.status });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(sha256: string, authHeader: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/${sha256}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      });
    } catch (e) {
      if (e instanceof TypeError) {
        throw new BlossomError(`Network error reaching ${this.baseUrl}, possible CORS or unreachable host`, { isCorsError: true });
      }
      throw e;
    }
    if (!res.ok) {
      throw new BlossomError(res.headers.get("X-Reason") || res.statusText, { status: res.status });
    }
  }
}
