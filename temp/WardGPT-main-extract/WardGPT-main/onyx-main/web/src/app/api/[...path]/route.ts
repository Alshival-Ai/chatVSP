import { INTERNAL_URL } from "@/lib/constants";
import { NextRequest, NextResponse } from "next/server";

/* NextJS is annoying and makes use use a separate function for
each request type >:( */

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function PUT(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function HEAD(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function OPTIONS(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

async function handleRequest(request: NextRequest, path: string[]) {
  if (
    process.env.NODE_ENV !== "development" &&
    // NOTE: Set this environment variable to 'true' for preview environments
    // Where you want finer-grained control over API access
    process.env.OVERRIDE_API_PRODUCTION !== "true"
  ) {
    return NextResponse.json(
      {
        message:
          "This API is only available in development mode. In production, something else (e.g. nginx) should handle this.",
      },
      { status: 404 }
    );
  }

  try {
    const backendUrl = new URL(`${INTERNAL_URL}/${path.join("/")}`);

    // Get the URL parameters from the request
    const urlParams = new URLSearchParams(request.url.split("?")[1]);

    // Append the URL parameters to the backend URL
    urlParams.forEach((value, key) => {
      backendUrl.searchParams.append(key, value);
    });

    // Build headers, optionally injecting debug auth cookie
    const headers = new Headers(request.headers);
    if (
      process.env.DEBUG_AUTH_COOKIE &&
      process.env.NODE_ENV === "development"
    ) {
      // Inject the debug auth cookie for local development against remote backend
      // Get from cloud site: DevTools → Application → Cookies → fastapiusersauth
      const existingCookies = headers.get("cookie") || "";
      const debugCookie = `fastapiusersauth=${process.env.DEBUG_AUTH_COOKIE}`;
      headers.set(
        "cookie",
        existingCookies ? `${existingCookies}; ${debugCookie}` : debugCookie
      );
    }

    const method = request.method.toUpperCase();
    const canHaveBody =
      method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    const fetchOptions: RequestInit & { duplex?: "half" } = {
      method: request.method,
      headers: headers,
      signal: request.signal,
      redirect: "manual",
    };

    if (canHaveBody && request.body) {
      fetchOptions.body = request.body;
      // Required for streaming request bodies in Node's fetch implementation.
      fetchOptions.duplex = "half";
    }

    const response = await fetch(backendUrl, fetchOptions);

    const setCookies =
      // @ts-ignore - undici provides getSetCookie in Node.
      response.headers.getSetCookie?.() ??
      (response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")]
        : []);

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("set-cookie");

    // Always pass through the backend response body directly.
    // TransformStream wrapping can break SSE forwarding under Node/Next runtime.
    const proxyResponse = new NextResponse(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
    for (const cookie of setCookies) {
      if (cookie) {
        proxyResponse.headers.append("set-cookie", cookie);
      }
    }
    return proxyResponse;
  } catch (error: unknown) {
    console.error("Proxy error:", error);
    return NextResponse.json(
      {
        message: "Proxy error",
        error:
          error instanceof Error ? error.message : "An unknown error occurred",
      },
      { status: 500 }
    );
  }
}
